import {
  RateLimiterRedis,
  RateLimiterMemory,
  RateLimiterQueue,
} from "rate-limiter-flexible";
import Redis, { Cluster } from "ioredis";
import { Connection, ConnectionConfig, PublicKey } from "@solana/web3.js";

export const ERROR_THRESHOLD = 20;
const ERROR_RESET_MS = 60000;
const DISABLED_RESET_MS = 60000;
const BASE_RETRY_DELAY = 500;
const MAX_RETRY_DELAY = 3000;
const DEFAULT_TIMEOUT_MS = 5000;
const KEY_PREFIX = "smart-rpc-rate-limit";
const DEFAULT_RATE_LIMITER_QUEUE_SIZE = 500;

export interface TransportConfig {
  rateLimit: number;
  weight: number;
  blacklist: string[];
  url: string;
  id: string;
  enableSmartDisable: boolean;
  enableFailover: boolean;
  maxRetries: number;
  redisClient?: Redis | Cluster;
  wsEndpoint?: string;
}

interface TransportState {
  errorCount: number;
  lastErrorResetTime: number;
  disabled: boolean;
  disabledTime: number;
  rateLimiterQueue: RateLimiterQueue;
  webSocket: WebSocketState;
}

export interface Transport {
  transportConfig: TransportConfig;
  transportState: TransportState;
  connection: Connection;
}

export interface TransportManagerConfig {
  strictPriorityMode?: boolean;
  skipLastResortSends?: boolean;
  metricCallback?: MetricCallback;
  queueSize?: number;
  timeoutMs?: number;
}

interface Metric {
  method: string;
  id: string;
  latency: number;
  statusCode: number | string | undefined | null;
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

export type MetricCallback = (metricName: string, metricValue: Metric) => void;

interface WebSocketState {
  isConnected: boolean;
  subscriptions: Map<number, string>;
}

export class TransportManager {
  private transports: Transport[] = [];
  private metricCallback?: MetricCallback;
  private strictPriorityMode: boolean = false;
  private skipLastResortSends: boolean = false;
  private queueSize?: number;
  private timeoutMs?: number;
  smartConnection: Connection;
  fanoutConnection: Connection;
  raceConnection: Connection;

  constructor(
    initialTransports: TransportConfig[],
    config?: TransportManagerConfig
  ) {
    this.strictPriorityMode = config?.strictPriorityMode ?? false;
    this.skipLastResortSends = config?.skipLastResortSends ?? false;
    this.metricCallback = config?.metricCallback;
    this.queueSize = config?.queueSize;
    this.timeoutMs = config?.timeoutMs;
    this.updateTransports(initialTransports);

    const dummyConnection = new Connection(
      this.transports[0].transportConfig.url
    );

    this.smartConnection = new Proxy(dummyConnection, {
      get: (target, prop, receiver) => {
        const originalMethod = target[prop];
        if (
          typeof originalMethod === "function" &&
          originalMethod.constructor.name === "AsyncFunction"
        ) {
          return (...args) => {
            return this.smartTransport(prop, ...args);
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    });

    this.fanoutConnection = new Proxy(dummyConnection, {
      get: (target, prop, receiver) => {
        const originalMethod = target[prop];
        if (
          typeof originalMethod === "function" &&
          originalMethod.constructor.name === "AsyncFunction"
        ) {
          return (...args) => {
            return this.fanout(prop, ...args);
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    });

    this.raceConnection = new Proxy(dummyConnection, {
      get: (target, prop, receiver) => {
        const originalMethod = target[prop];
        if (
          typeof originalMethod === "function" &&
          originalMethod.constructor.name === "AsyncFunction"
        ) {
          return (...args) => {
            return this.race(prop, ...args);
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    });
  }

  settleAllWithTimeout = async <T>(
    promises: Array<Promise<T>>
  ): Promise<Array<T>> => {
    const values: T[] = [];

    await Promise.allSettled(
      promises.map((promise) =>
        Promise.race([
          promise,
          this.timeout(this.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        ])
      )
    ).then((result) =>
      result.forEach((d) => {
        if (d.status === "fulfilled") {
          values.push(d.value as T);
        }
      })
    );

    return values;
  };

  updateTransports(newTransports: TransportConfig[]): void {
    this.transports = newTransports.map((config) =>
      this.createTransport(config)
    );
  }

  updateMockTransports(newTransports: Transport[]) {
    this.transports = newTransports;
  }

  getTransports(): Transport[] {
    return this.transports;
  }

  enableStrictPriorityMode(): void {
    this.strictPriorityMode = true;
  }

  disableStrictPriorityMode(): void {
    this.strictPriorityMode = false;
  }

  private createTransport(config: TransportConfig): Transport {
    if (config.id === "" || config.id.includes(" ")) {
      throw new Error(
        "Invalid transport ID. The ID must not be empty and must not contain spaces."
      );
    }

    let rateLimiter: RateLimiterRedis | RateLimiterMemory;

    if (config.redisClient) {
      rateLimiter = new RateLimiterRedis({
        storeClient: config.redisClient,
        points: config.rateLimit,
        duration: 1,
        keyPrefix: `${KEY_PREFIX}:${config.id}`,
      });
    } else {
      rateLimiter = new RateLimiterMemory({
        points: config.rateLimit,
        duration: 1,
        keyPrefix: `${KEY_PREFIX}:${config.id}`,
      });
    }

    let rateLimiterQueue = new RateLimiterQueue(rateLimiter, {
      maxQueueSize: this.queueSize ?? DEFAULT_RATE_LIMITER_QUEUE_SIZE,
    });

    const connectionConfig: ConnectionConfig = {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      wsEndpoint: config.wsEndpoint,
    };

    return {
      transportConfig: config,
      transportState: {
        errorCount: 0,
        lastErrorResetTime: Date.now(),
        disabled: false,
        disabledTime: 0,
        rateLimiterQueue,
        webSocket: {
          isConnected: false,
          subscriptions: new Map(),
        },
      },
      connection: new Connection(config.url, connectionConfig),
    };
  }

  private timeout(ms: number): Promise<any> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          new TimeoutError(`Operation timed out after ${ms} milliseconds`)
        );
      }, ms);
    }) as Promise<any>;
  }

  triggerMetricCallback(metricName: string, metricValue: Metric) {
    if (this.metricCallback) {
      try {
        this.metricCallback(metricName, metricValue);
      } catch (e) {
        console.error("Error in metric callback:", e);
      }
    }
  }

  selectTransport(availableTransports: Transport[]): Transport {
    if (this.strictPriorityMode) {
      return availableTransports.reduce((max, transport) =>
        max.transportConfig.weight > transport.transportConfig.weight
          ? max
          : transport
      );
    }

    let totalWeight = availableTransports.reduce(
      (sum, t) => sum + t.transportConfig.weight,
      0
    );
    let randomNum = Math.random() * totalWeight;

    for (const transport of availableTransports) {
      randomNum -= transport.transportConfig.weight;
      if (randomNum <= 0) {
        return transport;
      }
    }

    return availableTransports[0];
  }

  private availableTransportsForMethod(methodName) {
    return this.transports.filter(
      (t) => !t.transportConfig.blacklist.includes(methodName)
    );
  }

  private async fanout(methodName, ...args): Promise<any[]> {
    const availableTransports = this.availableTransportsForMethod(methodName);

    const transportPromises = availableTransports.map((transport) =>
      this.attemptSendWithRetries(transport, methodName, ...args)
    );

    const results = await this.settleAllWithTimeout(transportPromises);

    return results;
  }

  private async race(methodName, ...args): Promise<any> {
    const availableTransports = this.availableTransportsForMethod(methodName);

    const transportPromises = availableTransports.map((transport) =>
      Promise.race([
        this.attemptSendWithRetries(transport, methodName, ...args),
        this.timeout(this.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ])
    );

    return new Promise((resolve, reject) => {
      let errorCount = 0;
      transportPromises.forEach((promise) => {
        promise.then(resolve).catch((error) => {
          errorCount++;
          if (errorCount === transportPromises.length) {
            reject(new Error("All transports failed or timed out"));
          }
        });
      });
    });
  }

  private async sendRequest(
    transport: Transport,
    methodName,
    ...args
  ): Promise<any> {
    let latencyStart = Date.now();

    try {
      const result = await Promise.race([
        transport.connection[methodName](...args),
        this.timeout(this.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ]);

      let latencyEnd = Date.now();
      let latency = latencyEnd - latencyStart;

      this.triggerMetricCallback("SuccessfulRequest", {
        method: methodName,
        id: transport.transportConfig.id,
        latency: latency,
        statusCode: 200,
      });

      if (typeof result === "object" && !!result) {
        result.SmartRpcProvider = transport.transportConfig.id;
      }

      return result;
    } catch (error: any) {
      let timedOut = error instanceof TimeoutError;

      let match = error.message?.match(/"code"\s*:\s*(\d+)/);

      const currentTime = Date.now();

      let latencyEnd = currentTime;
      let latency = latencyEnd - latencyStart;

      this.triggerMetricCallback("ErrorRequest", {
        method: methodName,
        id: transport.transportConfig.id,
        latency: latency,
        statusCode: timedOut
          ? "timeout"
          : error.statusCode ??
            (error.response ? error.response.status : null) ??
            (match ? parseInt(match[1]) : null),
      });

      if (
        currentTime - transport.transportState.lastErrorResetTime >=
        ERROR_RESET_MS
      ) {
        transport.transportState.errorCount = 0;
        transport.transportState.lastErrorResetTime = currentTime;
      }

      transport.transportState.errorCount++;

      if (
        transport.transportState.errorCount > ERROR_THRESHOLD &&
        transport.transportConfig.enableSmartDisable
      ) {
        transport.transportState.disabled = true;
        transport.transportState.disabledTime = currentTime;
      }

      throw error;
    }
  }

  private async enqueueRequest(
    transport: Transport,
    methodName,
    ...args
  ): Promise<any> {
    if (!transport.transportState.rateLimiterQueue) {
      throw new Error(
        "RateLimiterQueue is not initialized for this transport."
      );
    }

    await transport.transportState.rateLimiterQueue.removeTokens(1);

    return await this.sendRequest(transport, methodName, ...args);
  }

  private async attemptSendWithRetries(
    transport: Transport,
    methodName,
    ...args
  ) {
    for (
      let attempt = 0;
      attempt <= transport.transportConfig.maxRetries;
      attempt++
    ) {
      try {
        return await this.enqueueRequest(transport, methodName, ...args);
      } catch (error: any) {
        let match = error.message?.match(/"code"\s*:\s*(\d+)/);

        if (attempt === transport.transportConfig.maxRetries) {
          if (
            error.statusCode === 429 ||
            (error.response && error.response.status === 429) ||
            (match && parseInt(match[1]) === 429)
          ) {
            throw new Error("Maximum retry attempts reached for HTTP 429.");
          } else {
            throw error;
          }
        } else if (
          error.statusCode === 403 ||
          (error.response && error.response.status === 403) ||
          (match && parseInt(match[1]) === 403)
        ) {
          throw error;
        }

        let delay = Math.min(
          MAX_RETRY_DELAY,
          BASE_RETRY_DELAY * Math.pow(2, attempt)
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async smartTransport(methodName, ...args): Promise<any[]> {
    let availableTransports = this.availableTransportsForMethod(methodName);
    let recentError: any = null;

    while (availableTransports.length > 0) {
      const transport = this.selectTransport(availableTransports);

      if (transport.transportState.disabled) {
        if (
          Date.now() - transport.transportState.disabledTime >=
          DISABLED_RESET_MS
        ) {
          transport.transportState.disabled = false;
          transport.transportState.disabledTime = 0;
        } else {
          availableTransports = availableTransports.filter(
            (t) => t !== transport
          );

          continue;
        }
      }

      try {
        return await this.attemptSendWithRetries(
          transport,
          methodName,
          ...args
        );
      } catch (e) {
        if (!transport.transportConfig.enableFailover) {
          throw e;
        }
        recentError = e;
      }

      availableTransports = availableTransports.filter((t) => t !== transport);
    }

    if (!this.skipLastResortSends) {
      let lastResortTransports = this.availableTransportsForMethod(methodName);
      for (let i = 0; i < lastResortTransports.length; i++) {
        try {
          return await this.sendRequest(
            lastResortTransports[i],
            methodName,
            ...args
          );
        } catch (error) {
          console.error(`Final attempt with transport failed: ${error}`);
        }
      }
    }

    let error =
      recentError ??
      new Error("No available transports for the requested method.");
    throw error;
  }

  private async subscribeToAccountChanges(
    transport: Transport,
    accountKey: string,
    callback: (accountInfo: any) => void
  ): Promise<number> {
    try {
      const pubKey = new PublicKey(accountKey);
      const subscriptionId = await transport.connection.onAccountChange(
        pubKey,
        callback,
        "confirmed"
      );

      transport.transportState.webSocket.subscriptions.set(
        subscriptionId,
        accountKey
      );
      transport.transportState.webSocket.isConnected = true;

      return subscriptionId;
    } catch (error) {
      console.error(`WebSocket subscription error:`, error);
      throw error;
    }
  }

  private async unsubscribeFromAccount(
    transport: Transport,
    subscriptionId: number
  ): Promise<void> {
    try {
      await transport.connection.removeAccountChangeListener(subscriptionId);
      transport.transportState.webSocket.subscriptions.delete(subscriptionId);

      if (transport.transportState.webSocket.subscriptions.size === 0) {
        transport.transportState.webSocket.isConnected = false;
      }
    } catch (error) {
      console.error(`WebSocket unsubscribe error:`, error);
      throw error;
    }
  }

  private isWebSocketConnected(transport: Transport): boolean {
    return transport.transportState.webSocket.isConnected;
  }
}

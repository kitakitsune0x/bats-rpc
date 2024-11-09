# Solana Smart RPC

Intelligent transport layer for Solana RPCs that handles load balancing, rate limit throttling, failover, fanouts, retries, and websocket connections. Built on top of [@solana/web3.js](https://www.npmjs.com/package/@solana/web3.js).


# Getting Started

Smart RPC is a proxy to the existing Connection class with added websocket support, so migrating should be very simple. Under the hood, when you make requests, it proxies to underlying logic that determines which transport to send your request to.

```tsx
import { defaultTransportConfig, TransportConfig } from "@kitakitsune0x/bats-rpc"

let defaultTransportConfig: TransportConfig[] = [
  {
    rateLimit: 50,
    weight: 50,
    blacklist: [],
    id: "Triton",
    url: TRITON_MAINNET_P0,
    enableSmartDisable: true,
    enableFailover: true,
    maxRetries: 2,
    wsEndpoint: TRITON_MAINNET_WS
  },
  {
    rateLimit: 50,
    weight: 50,
    blacklist: [],
    id: "Helius",
    url: HELIUS_FE_MAINNET_P0,
    enableSmartDisable: true,
    enableFailover: true,
    maxRetries: 2,
    wsEndpoint: HELIUS_FE_MAINNET_P0
  },
];

const smartRpcMetricLogger: MetricCallback = (_, metricValue) => {
  console.log(metricValue);
};

let optionalConfig: TransportManagerConfig = {
  strictPriorityMode: true, // if set, will always try highest weighted provider first instead of load balancing
  metricCallback: smartRpcMetricLogger, // callback function for successful and failed requests
  queueSize: 1000, // configurable queue size for underlying rate limit queue
  timeoutMs: 5000, // configurable timeout for underlying requests
};

const transportManager = new TransportManager(defaultTransportConfig, optionalConfig);
export const smartConnection = transportManager.smartConnection;

const resp = await smartConnection.getLatestBlockhash();
console.log(resp.blockhash.toString());
```

# Connection Types

## Smart connection

This is the recommended connection for most cases. It's a drop-in replacement for the existing Connection class with built-in features such as load balancing, failover, retries and websocket support.

## Websocket connection

For real-time updates and subscriptions, Smart RPC provides websocket support through the standard Solana websocket endpoints. You can subscribe to account changes, logs, program updates and more:

```typescript
const ws = new WebSocket(WSS_ENDPOINT);

ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'programSubscribe',
    params: [
      programId,
      {
        encoding: 'base64',
        commitment: 'finalized'
      }
    ]
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received update:', data);
};
```

## Fanout connection

Sometimes you might want to send the same request to multiple connections. One example is `getLatestBlockhash`, since some RPC providers may occasionally lag behind others. When signing transacitons, fetching the most up-to-date blockhash across providers helps increase the chance your transaction will succeed. Another example is `sendTransaction`. You may want to send your transaction to multiple providers to get the fastest confirmation and increase the chance of success.

## Race connection

Assuming most providers are up-to-date, you may want to race among them to get the fastest response. For example, you could send `getAccountInfo` to multiple providers and abort after the fastest provider returns a response.

# Features

## Load Balancing

By default, Smart RPC will load balance based on the provided weights. You can configure these weights and update them at runtime (e.g. if you need a killswitch for an RPC provider).

## In-memory and Redis Rate Limiting

Smart RPC supports in-memory and pooled rate limiting. By default, rate limting will happen in-memory. If you want to pool rate limits, you can pass in an optional IORedisClient (either a single instance or cluster).

## Retries & Failover

If a particular transport has filled up its rate limit queue or encounters an error, it will automatically failover to the next transport. This makes your requests more likely to succeed if there are transient issues.

## Smart Disable

If a particular transport reaches an error threshold within a short period of time, Smart RPC will shut off requests to that transport for a short cooloff period. This can happen if you hit rate limits or if the RPC provider is having issues. Instead of spamming them, requests will be sent to a different provider.

# Known Limitations

Smart RPC provides full websocket subscription support through standard Solana websocket endpoints. For HTTP RPC requests that require strict consistency across nodes, we recommend using the `minimumContextSlot` parameter to ensure responses are from up-to-date nodes.

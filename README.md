# Venice x402 Client

Wallet-native access to the Venice API. No API keys.

This SDK handles the two main pieces of the Venice x402 flow:

- wallet authentication with a fresh `SIGN-IN-WITH-X` header on every request
- balance-backed payments, including `topUp()` with USDC on Base

## Install

```bash
npm install venice-x402-client
```

## Quick Start

```typescript
import { VeniceClient } from 'venice-x402-client'

const privateKey = process.env.WALLET_PRIVATE_KEY ?? process.env.WALLET_KEY
if (!privateKey) {
  throw new Error('Set WALLET_PRIVATE_KEY or WALLET_KEY')
}

const venice = new VeniceClient(privateKey)

const balance = await venice.getBalance()

if (!balance.canConsume) {
  // New wallets usually need a top-up first unless they already have
  // spendable DIEM-backed balance linked to a Venice account.
  await venice.topUp(10)
}

const response = await venice.chat({
  model: 'llama-3.3-70b',
  messages: [{ role: 'user', content: 'Say exactly: wallet-native inference works' }],
})

console.log(response.choices[0]?.message?.content)
```

## How Venice x402 Works

With Venice, your wallet is the identity layer and your Venice balance is the spend layer.

1. The SDK generates a fresh `SIGN-IN-WITH-X` header for each request: an x402 sign-in-with-x proof signed with your wallet on Base (`eip155:8453`, `eip191`).
2. Venice checks whether the wallet has spendable balance.
3. Paid endpoints spend from that balance.
4. If the wallet does not have spendable balance yet, `topUp()` fetches Venice's x402 payment requirements, signs the Base USDC payment, and retries the top-up request.

The SDK also updates its cached balance from `X-Balance-Remaining` response headers whenever Venice returns them.

## Auto Top-Up

If you want paid requests to top up automatically when Venice returns `402`, enable `autoTopUp`:

```typescript
import { VeniceClient } from 'venice-x402-client'

const venice = new VeniceClient(privateKey, {
  autoTopUp: {
    enabled: true,
    amount: 10,
  },
})

const chat = await venice.chat({
  model: 'llama-3.3-70b',
  messages: [{ role: 'user', content: 'Hello!' }],
})
```

## API Base URL

The client defaults to `https://api.venice.ai`, but you can point it at another Venice-compatible deployment:

```typescript
const venice = new VeniceClient(privateKey, {
  apiUrl: 'http://localhost:4000',
  timeoutMs: 180_000,
})
```

## Supported Helpers

Core:

- `models()`
- `chat()`
- `chatStream()`
- `responses.create()`
- `responses.stream()`
- `embeddings()`

x402 account:

- `getBalance()`
- `getTransactions()`
- `topUp()`

Images:

- `images.generate()`
- `images.generations()`
- `images.upscale()`
- `images.edit()`
- `images.multiEdit()`
- `images.backgroundRemove()`

Audio:

- `audio.speech()`
- `audio.transcribe()`
- `audio.queue()`
- `audio.retrieve()`
- `audio.complete()`

Video:

- `video.queue()`
- `video.retrieve()`
- `video.generate()`
- `video.complete()`
- `video.transcribe()`

## Low-Level Access

If you need a route-specific helper that the SDK does not wrap yet, you can still use:

- `request(path, init)` for JSON responses
- `requestRaw(path, init)` for raw `Response` access
- `createAuthFetch(...)` for tools that accept a custom `fetch`
- `VeniceSigner` if you need low-level auth/payment signing
- `VeniceError` for structured SDK errors

## With OpenAI-Compatible Tools

```typescript
import { createAuthFetch } from 'venice-x402-client'

const authFetch = createAuthFetch(privateKey)
```

Any client that lets you provide a custom `fetch` can use that to send Venice requests with wallet auth.

## Notes

- Node `>=18` is required.
- `audio.speech()` returns a `Blob`.
- `audio.transcribe()` can return JSON or text depending on `response_format`.
- `video.generate()` polls until completion and returns the final media blob.
- Venice spends linked DIEM-backed balance first when it exists. Otherwise, top up with USDC on Base.

## Links

- [Venice AI](https://venice.ai)
- [x402 Protocol](https://github.com/coinbase/x402)

## License

MIT

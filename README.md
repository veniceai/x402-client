# Venice x402 Client

AI inference with your crypto wallet. No API keys.

## Install

```bash
npm install @venice-ai/x402-client
```

## Usage

```typescript
import { VeniceClient } from '@venice-ai/x402-client'

const venice = new VeniceClient(process.env.WALLET_KEY)

// New wallets usually need a top-up first unless the wallet already has
// spendable DIEM-backed balance linked to a Venice account.
await venice.topUp(10)

const response = await venice.chat({
  model: 'kimi-k2-5',
  messages: [{ role: 'user', content: 'Hello!' }]
})
```

The client generates a fresh `X-Sign-In-With-X` header for each request and
automatically updates the local balance from `X-Balance-Remaining` responses.

## With OpenAI-Compatible Tools

```typescript
import { createAuthFetch } from '@venice-ai/x402-client'

// Use with any tool that accepts a custom fetch
const authFetch = createAuthFetch(process.env.WALLET_KEY)
```

## Payment

- **USDC** - Pay per request on Base
- **DIEM** - Stake for daily credits (1 DIEM = $1/day forever)

Venice spends linked DIEM-backed balance first when it exists. If the wallet
does not have spendable balance, top up with USDC on Base via
`POST /api/v1/x402/top-up`.

## Links

- [Venice AI](https://venice.ai)
- [x402 Protocol](https://github.com/coinbase/x402)

## License

MIT

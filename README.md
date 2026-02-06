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

const response = await venice.chat({
  model: 'llama-3.3-70b',
  messages: [{ role: 'user', content: 'Hello!' }]
})
```

## Payment

- **USDC** - Pay per request on Base
- **DIEM** - Stake for daily credits (1 DIEM = $1/day forever)

## Links

- [Venice AI](https://venice.ai)
- [x402 Protocol](https://github.com/coinbase/x402)

## License

MIT


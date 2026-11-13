import { Wallet } from 'ethers'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VeniceClient, VeniceError } from '../src/index'

const PRIVATE_KEY = Wallet.createRandom().privateKey
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

describe('VeniceClient.topUp', () => {
  afterEach(() => vi.unstubAllGlobals())

  const solanaAccept = {
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '5000000',
    payTo: '8qUL23aSj7mDWdoLMXGHFvnVCT9wd7jXcysiekroADEL',
  }
  const baseAccept = {
    network: 'eip155:8453',
    asset: BASE_USDC,
    amount: '5000000',
    payTo: '0x2670B922ef37C7Df47158725C0CC407b5382293F',
  }

  function stubTopUp(accepts: unknown[]) {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ x402Version: 2, accepts }), {
          status: 402,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { newBalance: 5 } })))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('pays the Base entry even when Solana is listed first', async () => {
    stubTopUp([solanaAccept, baseAccept])
    const client = new VeniceClient(PRIVATE_KEY)
    const signPayment = vi.spyOn(client.signer, 'signPayment').mockResolvedValue('payment')

    await client.topUp(5)

    expect(signPayment.mock.calls[0][0]).toMatchObject({
      network: 'base',
      payTo: baseAccept.payTo,
    })
    expect(client.balance).toBe(5)
  })

  it('refuses when Venice offers no USDC top-up on Base', async () => {
    const fetchMock = stubTopUp([solanaAccept])
    const client = new VeniceClient(PRIVATE_KEY)
    const signPayment = vi.spyOn(client.signer, 'signPayment')

    await expect(client.topUp(5)).rejects.toEqual(
      new VeniceError('TOP_UP_ERROR', 'Venice offered no USDC top-up on Base'),
    )
    expect(signPayment).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

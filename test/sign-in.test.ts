import { Wallet, verifyMessage } from 'ethers'
import { SiweMessage } from 'siwe'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAuthFetch, VeniceSigner } from '../src/index'

const PRIVATE_KEY = Wallet.createRandom().privateKey
const RESOURCE = 'https://api.venice.ai/api/v1/chat/completions'

function decode(header: string) {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
}

describe('VeniceSigner.signIn', () => {
  it('builds an x402 sign-in-with-x proof for Base', async () => {
    const signer = new VeniceSigner(PRIVATE_KEY)

    const proof = decode(await signer.signIn(RESOURCE))

    expect(proof).toEqual({
      domain: 'api.venice.ai',
      address: signer.address,
      statement: 'Sign in to Venice AI',
      uri: RESOURCE,
      version: '1',
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
      issuedAt: expect.any(String),
      expirationTime: expect.any(String),
      chainId: 'eip155:8453',
      type: 'eip191',
      signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
    })
    expect(Date.parse(proof.expirationTime) - Date.parse(proof.issuedAt)).toBe(5 * 60 * 1000)
  })

  it('signs the EIP-4361 message a verifier rebuilds from the fields', async () => {
    const signer = new VeniceSigner(PRIVATE_KEY)
    const { chainId, type, signature, ...fields } = decode(await signer.signIn(RESOURCE))

    const message = new SiweMessage({
      ...fields,
      chainId: Number(chainId.split(':')[1]),
    }).prepareMessage()

    expect(type).toBe('eip191')
    expect(verifyMessage(message, signature)).toBe(signer.address)
  })

  it('uses a fresh nonce for every proof', async () => {
    const signer = new VeniceSigner(PRIVATE_KEY)

    const first = decode(await signer.signIn(RESOURCE))
    const second = decode(await signer.signIn(RESOURCE))

    expect(first.nonce).not.toBe(second.nonce)
  })
})

describe('createAuthFetch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the proof in the SIGN-IN-WITH-X header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)

    await createAuthFetch(PRIVATE_KEY)(RESOURCE)

    const headers = new Headers(fetchMock.mock.calls[0][1].headers)
    expect(decode(headers.get('SIGN-IN-WITH-X')!).uri).toBe(RESOURCE)
    expect(headers.has('X-Sign-In-With-X')).toBe(false)
  })
})

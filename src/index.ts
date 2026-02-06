import { Wallet } from 'ethers'
import { SiweMessage } from 'siwe'

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_API_URL = 'https://api.venice.ai'
const BASE_CHAIN_ID = 8453
const USDC_DECIMALS = 6
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SIGN_IN_EXPIRY_MS = 10 * 60 * 1000 // 10 minutes

// =============================================================================
// Types
// =============================================================================

export interface VeniceClientOptions {
  /** API endpoint (default: https://api.venice.ai) */
  apiUrl?: string
  /** Auto top-up settings when balance is insufficient */
  autoTopUp?: {
    enabled: boolean
    /** Amount in USD to top up */
    amount: number
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatParams {
  model: string
  messages: ChatMessage[]
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

export interface ChatResponse {
  id: string
  choices: Array<{
    index: number
    message: ChatMessage
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface Model {
  id: string
  object: string
  created: number
  owned_by: string
}

export interface ModelsResponse {
  object: string
  data: Model[]
}

export interface EmbeddingsParams {
  model: string
  input: string | string[]
}

export interface EmbeddingsResponse {
  object: string
  data: Array<{
    object: string
    embedding: number[]
    index: number
  }>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}

export interface ImageGenerateParams {
  model: string
  prompt: string
  width?: number
  height?: number
  n?: number
  style_preset?: string
}

export interface ImageResponse {
  created: number
  data: Array<{
    url?: string
    b64_json?: string
  }>
}

export interface SpeechParams {
  model: string
  input: string
  voice: string
  response_format?: 'mp3' | 'wav' | 'opus' | 'flac'
  speed?: number
}

export interface TranscribeParams {
  model: string
  file: Blob | Buffer
  language?: string
  response_format?: 'json' | 'text' | 'srt' | 'vtt'
}

export interface TranscribeResponse {
  text: string
}

// Video types
export interface VideoQueueParams {
  model: string
  prompt: string
  negative_prompt?: string
  /** Duration string like '5s', '10s' - check model for supported options */
  duration?: string
  aspect_ratio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4'
  resolution?: '480p' | '720p' | '1080p'
  image_url?: string
  end_image_url?: string
  audio?: boolean
}

export interface VideoQueueResponse {
  queue_id: string
  model: string
}

export interface VideoRetrieveParams {
  queue_id: string
  delete_after_retrieval?: boolean
}

export interface VideoRetrieveResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  video_url?: string
  error?: string
}

// =============================================================================
// VeniceSigner
// =============================================================================

/**
 * Low-level signer for x402 authentication.
 * Handles SIWE message signing and payment authorization.
 */
export class VeniceSigner {
  private readonly wallet: Wallet
  private readonly domain: string

  constructor(privateKey: string, apiUrl: string = DEFAULT_API_URL) {
    if (!privateKey || !privateKey.startsWith('0x')) {
      throw new VeniceError('INVALID_PRIVATE_KEY', 'Private key must be a hex string starting with 0x')
    }
    try {
      this.wallet = new Wallet(privateKey)
    } catch {
      throw new VeniceError('INVALID_PRIVATE_KEY', 'Invalid private key format')
    }
    this.domain = new URL(apiUrl).host
  }

  /** Wallet address (checksummed) */
  get address(): string {
    return this.wallet.address
  }

  /** Create X-Sign-In-With-X header for authentication */
  async signIn(): Promise<string> {
    const now = new Date()

    const message = new SiweMessage({
      domain: this.domain,
      address: this.wallet.address,
      statement: 'Sign in to Venice API',
      uri: `https://${this.domain}`,
      version: '1',
      chainId: BASE_CHAIN_ID,
      nonce: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      issuedAt: now.toISOString(),
      expirationTime: new Date(now.getTime() + SIGN_IN_EXPIRY_MS).toISOString(),
    })

    const messageString = message.prepareMessage()
    const signature = await this.wallet.signMessage(messageString)

    return Buffer.from(JSON.stringify({
      address: this.wallet.address,
      message: messageString,
      signature,
      timestamp: now.getTime(),
      chainId: BASE_CHAIN_ID,
    })).toString('base64')
  }

  /** Create X-402-Payment header for USDC payment */
  async signPayment(requirements: {
    asset: string
    amount: string
    payTo: string
  }): Promise<string> {
    const { createPaymentHeader } = await import('x402/client')
    const { createSigner } = await import('x402/types')
    const signer = await createSigner('base', this.wallet.privateKey as `0x${string}`)

    return createPaymentHeader(signer, 1, {
      scheme: 'exact',
      network: 'base',
      asset: requirements.asset,
      maxAmountRequired: requirements.amount,
      payTo: requirements.payTo,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
      resource: '',
      description: 'Venice x402 payment',
      mimeType: 'application/json',
      outputSchema: undefined,
    })
  }
}

// =============================================================================
// createAuthFetch
// =============================================================================

/**
 * Creates an authenticated fetch function for use with OpenAI-compatible tools.
 *
 * @example
 * ```typescript
 * const authFetch = createAuthFetch(privateKey)
 * const response = await authFetch('https://api.venice.ai/api/v1/models')
 * ```
 */
export function createAuthFetch(
  privateKey: string,
  options: { apiUrl?: string } = {}
): typeof fetch {
  const signer = new VeniceSigner(privateKey, options.apiUrl)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.set('X-Sign-In-With-X', await signer.signIn())
    return fetch(input, { ...init, headers })
  }
}

// =============================================================================
// VeniceClient
// =============================================================================

/**
 * High-level Venice API client with x402 authentication.
 *
 * @example
 * ```typescript
 * const venice = new VeniceClient(privateKey)
 * const response = await venice.chat({
 *   model: 'llama-3.3-70b',
 *   messages: [{ role: 'user', content: 'Hello!' }]
 * })
 * ```
 */
export class VeniceClient {
  /** API base URL */
  public readonly apiUrl: string

  /** Wallet signer for authentication */
  public readonly signer: VeniceSigner

  /** Authenticated fetch function */
  public readonly fetch: typeof fetch

  /** Image generation API */
  public readonly images: ImagesAPI

  /** Audio API (speech & transcription) */
  public readonly audio: AudioAPI

  /** Video generation API */
  public readonly video: VideoAPI

  private readonly autoTopUp?: VeniceClientOptions['autoTopUp']
  private _balance: number = 0

  constructor(privateKey: string, options: VeniceClientOptions = {}) {
    this.apiUrl = options.apiUrl || DEFAULT_API_URL
    this.autoTopUp = options.autoTopUp
    this.signer = new VeniceSigner(privateKey, this.apiUrl)
    this.fetch = createAuthFetch(privateKey, { apiUrl: this.apiUrl })
    this.images = new ImagesAPI(this)
    this.audio = new AudioAPI(this)
    this.video = new VideoAPI(this)
  }

  /** Current credit balance in USD */
  get balance(): number {
    return this._balance
  }

  /** Wallet address */
  get address(): string {
    return this.signer.address
  }

  /**
   * Make an authenticated request to the API.
   * Handles 402 responses with optional auto top-up.
   */
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.apiUrl}${path}`
    const response = await this.fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (response.status === 402) {
      if (this.autoTopUp?.enabled) {
        await this.topUp(this.autoTopUp.amount || 10)
        return this.request(path, options)
      }

      const data = await this.safeJson(response)
      throw new VeniceError('INSUFFICIENT_BALANCE', 'Insufficient balance', {
        currentBalance: data?.currentBalanceUsd,
        suggestedAmount: data?.suggestedTopUpUsd,
      })
    }

    if (!response.ok) {
      const data = await this.safeJson(response)
      throw new VeniceError('API_ERROR', data?.error || `Request failed with status ${response.status}`, {
        status: response.status,
      })
    }

    this.updateBalance(response)
    return response.json()
  }

  /** List available models */
  async models(): Promise<ModelsResponse> {
    return this.request('/api/v1/models')
  }

  /** Create a chat completion */
  async chat(params: ChatParams): Promise<ChatResponse> {
    return this.request('/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /** Create embeddings for text */
  async embeddings(params: EmbeddingsParams): Promise<EmbeddingsResponse> {
    return this.request('/api/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /** Fetch current balance from the server */
  async getBalance(): Promise<{
    balanceUsd: number
    canConsume: boolean
    minimumTopUpUsd: number
    suggestedTopUpUsd: number
  }> {
    const response = await fetch(`${this.apiUrl}/api/v1/x402/balance/${this.address}`)
    if (!response.ok) {
      throw new VeniceError('BALANCE_ERROR', 'Failed to fetch balance')
    }
    const data = await response.json()
    this._balance = data.data.balanceUsd
    return data.data
  }

  /** Top up balance with USDC on Base */
  async topUp(amountUsd: number): Promise<void> {
    if (amountUsd <= 0) {
      throw new VeniceError('INVALID_AMOUNT', 'Top-up amount must be positive')
    }

    // Step 1: Get payment requirements
    const reqResponse = await fetch(`${this.apiUrl}/api/v1/x402/top-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountUsd }),
    })

    if (reqResponse.status !== 402) {
      const data = await this.safeJson(reqResponse)
      throw new VeniceError('TOP_UP_ERROR', data?.error || 'Failed to get payment requirements')
    }

    const requirements = await reqResponse.json()

    // Step 2: Sign and submit payment
    const paymentHeader = await this.signer.signPayment({
      asset: requirements.paymentInfo?.tokenAddress || USDC_ADDRESS,
      amount: String(Math.floor(amountUsd * Math.pow(10, USDC_DECIMALS))),
      payTo: requirements.paymentInfo?.receiverWallet,
    })

    const payResponse = await fetch(`${this.apiUrl}/api/v1/x402/top-up`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-402-Payment': paymentHeader,
      },
      body: JSON.stringify({ amount: amountUsd }),
    })

    if (!payResponse.ok) {
      const data = await this.safeJson(payResponse)
      throw new VeniceError('TOP_UP_FAILED', data?.error || 'Top-up failed')
    }

    const result = await payResponse.json()
    this._balance = result.data?.newBalance ?? this._balance + amountUsd
  }

  private updateBalance(response: Response): void {
    const header = response.headers.get('X-Balance-Remaining')
    if (header) {
      const parsed = parseFloat(header)
      if (!Number.isNaN(parsed)) {
        this._balance = parsed
      }
    }
  }

  private async safeJson(response: Response): Promise<{ error?: string; currentBalanceUsd?: number; suggestedTopUpUsd?: number } | null> {
    try {
      return await response.json()
    } catch {
      return null
    }
  }
}

// =============================================================================
// ImagesAPI
// =============================================================================

/** Image generation API */
class ImagesAPI {
  constructor(private readonly client: VeniceClient) {}

  /** Generate images from a text prompt */
  async generate(params: ImageGenerateParams): Promise<ImageResponse> {
    return this.client.request('/api/v1/image/generate', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }
}

// =============================================================================
// AudioAPI
// =============================================================================

/** Audio API for speech synthesis and transcription */
class AudioAPI {
  constructor(private readonly client: VeniceClient) {}

  /** Generate speech audio from text */
  async speech(params: SpeechParams): Promise<Blob> {
    const response = await this.client.fetch(`${this.client.apiUrl}/api/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })

    if (!response.ok) {
      let errorMessage = 'Speech generation failed'
      try {
        const data = await response.json()
        errorMessage = data.error || errorMessage
      } catch {
        // Ignore JSON parse error
      }
      throw new VeniceError('API_ERROR', errorMessage)
    }

    return response.blob()
  }

  /** Transcribe audio to text */
  async transcribe(params: TranscribeParams): Promise<TranscribeResponse> {
    const formData = new FormData()
    formData.append('model', params.model)
    formData.append('file', params.file as Blob)
    if (params.language) formData.append('language', params.language)
    if (params.response_format) formData.append('response_format', params.response_format)

    const response = await this.client.fetch(`${this.client.apiUrl}/api/v1/audio/asr`, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      let errorMessage = 'Transcription failed'
      try {
        const data = await response.json()
        errorMessage = data.error || errorMessage
      } catch {
        // Ignore JSON parse error
      }
      throw new VeniceError('API_ERROR', errorMessage)
    }

    return response.json()
  }
}

// =============================================================================
// VideoAPI
// =============================================================================

/** Video generation API */
class VideoAPI {
  constructor(private readonly client: VeniceClient) {}

  /**
   * Queue a video generation request.
   * Returns a queue_id to poll for results.
   */
  async queue(params: VideoQueueParams): Promise<VideoQueueResponse> {
    return this.client.request('/api/v1/video/queue', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /**
   * Retrieve video generation status/result.
   * Poll this endpoint until status is 'completed' or 'failed'.
   */
  async retrieve(params: VideoRetrieveParams): Promise<VideoRetrieveResponse> {
    return this.client.request('/api/v1/video/retrieve', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /**
   * Generate a video and wait for completion.
   * Polls automatically until the video is ready.
   *
   * @param params Video generation parameters
   * @param pollIntervalMs Polling interval in milliseconds (default: 5000)
   * @param timeoutMs Maximum wait time in milliseconds (default: 300000 = 5 min)
   */
  async generate(
    params: VideoQueueParams,
    pollIntervalMs: number = 5000,
    timeoutMs: number = 300000
  ): Promise<string> {
    const { queue_id } = await this.queue(params)

    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))

      const result = await this.retrieve({ queue_id })

      if (result.status === 'completed' && result.video_url) {
        return result.video_url
      }

      if (result.status === 'failed') {
        throw new VeniceError('VIDEO_FAILED', result.error || 'Video generation failed')
      }
    }

    throw new VeniceError('VIDEO_TIMEOUT', `Video generation timed out after ${timeoutMs}ms`)
  }
}

// =============================================================================
// VeniceError
// =============================================================================

/** Error class for Venice API errors */
export class VeniceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'VeniceError'
  }
}

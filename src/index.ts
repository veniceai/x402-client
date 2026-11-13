import { Wallet } from 'ethers'
import { SiweMessage } from 'siwe'

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_API_URL = 'https://api.venice.ai'
const BASE_CHAIN_ID = 8453
const BASE_NETWORK = `eip155:${BASE_CHAIN_ID}`
const USDC_DECIMALS = 6
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED'
const SIGN_IN_HEADER = 'SIGN-IN-WITH-X'
const SIGN_IN_STATEMENT = 'Sign in to Venice AI'
const SIGN_IN_TYPE = 'eip191'
const SIGN_IN_NONCE_BYTES = 16 // 32 hex characters, as the sign-in-with-x spec generates them
const SIGN_IN_EXPIRY_MS = 5 * 60 * 1000 // Venice treats SIWX payloads as short-lived
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000
const DEFAULT_TIMEOUT_MS = 180_000

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
  /** Request timeout in ms (default: 180000). Set 0 to disable. */
  timeoutMs?: number
}

interface TopUpAccept {
  protocol?: string
  version?: number
  network: string
  asset: string
  amount: string
  payTo: string
}

interface TopUpRequirementsResponse {
  x402Version: number
  accepts: TopUpAccept[]
}

type SdkPaymentNetwork = 'base' | 'base-sepolia'

interface SdkPaymentRequirements {
  scheme: 'exact'
  network: SdkPaymentNetwork
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: string
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  extra?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
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

export interface ResponsesParams extends Record<string, unknown> {
  model: string
  input?: unknown
  stream?: boolean
}

export interface ResponsesResponse extends Record<string, unknown> {}

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

export type OpenAiImageGenerateParams = Record<string, unknown>
export type ImageMutationParams = object | FormData
export type ImageMutationResponse = Blob | Record<string, unknown>

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
  filename?: string
  mimeType?: string
  language?: string
  response_format?: 'json' | 'text' | 'srt' | 'vtt'
}

export interface TranscribeResponse {
  text: string
}

export type TranscribeResult = TranscribeResponse | string

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
  status?: string
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

export interface QueueResponse {
  model: string
  queue_id: string
  status?: string
}

export interface CompletionResponse {
  success: boolean
}

export interface MediaRetrieveStatusResponse extends Record<string, unknown> {
  status: string
  average_execution_time?: number
  execution_duration?: number
  error?: string
}

export type MediaRetrieveResponse = MediaRetrieveStatusResponse | Blob
export type AudioQueueParams = Record<string, unknown>
export type AudioRetrieveParams = Record<string, unknown>
export type AudioCompleteParams = Record<string, unknown>
export type VideoCompleteParams = Record<string, unknown>
export type VideoTranscriptionParams = Record<string, unknown>
export type VideoTranscriptionResponse = Record<string, unknown> | string

export interface X402Transaction {
  id: string
  amount: number
  balanceAfter: number
  type: string
  createdAt: string
  requestId: string | null
  modelId: string | null
}

export interface X402TransactionsResponse {
  walletAddress: string
  currentBalance: number
  transactions: X402Transaction[]
  pagination: {
    limit: number
    offset: number
    hasMore: boolean
  }
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
  private readonly apiOrigin: string

  constructor(privateKey: string, apiUrl: string = DEFAULT_API_URL) {
    if (!privateKey || !privateKey.startsWith('0x')) {
      throw new VeniceError('INVALID_PRIVATE_KEY', 'Private key must be a hex string starting with 0x')
    }
    try {
      this.wallet = new Wallet(privateKey)
    } catch {
      throw new VeniceError('INVALID_PRIVATE_KEY', 'Invalid private key format')
    }
    const url = new URL(apiUrl)
    this.apiOrigin = url.origin
    this.domain = url.host
  }

  /** Wallet address (checksummed) */
  get address(): string {
    return this.wallet.address
  }

  /** API origin used to resolve relative request URLs. */
  get origin(): string {
    return this.apiOrigin
  }

  /**
   * Create a fresh SIGN-IN-WITH-X header for a specific resource.
   * The payload is the x402 sign-in-with-x proof: the signed EIP-4361 fields,
   * a CAIP-2 chainId, the signature type and the signature.
   */
  async signIn(resourceUrl?: string): Promise<string> {
    const now = new Date()
    const requestUrl = resourceUrl ? new URL(resourceUrl, this.apiOrigin).toString() : this.apiOrigin

    const fields = {
      domain: this.domain,
      address: this.wallet.address,
      statement: SIGN_IN_STATEMENT,
      uri: requestUrl,
      version: '1',
      nonce: createNonce(),
      issuedAt: now.toISOString(),
      expirationTime: new Date(now.getTime() + SIGN_IN_EXPIRY_MS).toISOString(),
    }
    // The signed message carries the bare chain reference; the proof carries CAIP-2.
    const message = new SiweMessage({ ...fields, chainId: BASE_CHAIN_ID }).prepareMessage()
    const signature = await this.wallet.signMessage(message)

    return Buffer.from(JSON.stringify({
      ...fields,
      chainId: BASE_NETWORK,
      type: SIGN_IN_TYPE,
      signature,
    })).toString('base64')
  }

  /** Create X-402-Payment header for USDC payment */
  async signPayment(requirements: SdkPaymentRequirements, x402Version: number): Promise<string> {
    const { createPaymentHeader } = await import('x402/client')
    const { createSigner } = await import('x402/types')
    const signer = await createSigner('base', this.wallet.privateKey as `0x${string}`)

    return createPaymentHeader(signer, x402Version, requirements)
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
  signerOrKey: VeniceSigner | string,
  options: { apiUrl?: string } = {}
): typeof fetch {
  const signer = signerOrKey instanceof VeniceSigner
    ? signerOrKey
    : new VeniceSigner(signerOrKey, options.apiUrl)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    const requestUrl = resolveRequestUrl(input, signer.origin)
    headers.set(SIGN_IN_HEADER, await signer.signIn(requestUrl))
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

  /** Responses API */
  public readonly responses: ResponsesAPI

  /** Audio API (speech & transcription) */
  public readonly audio: AudioAPI

  /** Video generation API */
  public readonly video: VideoAPI

  private readonly autoTopUp?: VeniceClientOptions['autoTopUp']
  private readonly timeoutMs: number
  private _balance: number = 0

  constructor(privateKey: string, options: VeniceClientOptions = {}) {
    this.apiUrl = options.apiUrl || DEFAULT_API_URL
    this.autoTopUp = options.autoTopUp
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.signer = new VeniceSigner(privateKey, this.apiUrl)
    this.fetch = createAuthFetch(this.signer)
    this.images = new ImagesAPI(this)
    this.responses = new ResponsesAPI(this)
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
   * Low-level authenticated request returning the raw Response.
   * Handles 429 retries and 402 auto top-up.
   */
  async requestRaw(path: string, options: RequestInit = {}, retryCount = 0): Promise<Response> {
    const url = `${this.apiUrl}${path}`

    const controller = new AbortController()
    const timeoutId = this.timeoutMs > 0
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : undefined

    let response: Response
    try {
      response = await this.fetch(url, {
        ...options,
        signal: options.signal ?? controller.signal,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError' && !options.signal) {
        throw new VeniceError('TIMEOUT', `Request timed out after ${this.timeoutMs}ms`)
      }
      throw err
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }

    if (response.status === 429 && retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * Math.pow(2, retryCount)
      await new Promise(resolve => setTimeout(resolve, delay))
      return this.requestRaw(path, options, retryCount + 1)
    }

    if (response.status === 402) {
      if (this.autoTopUp?.enabled) {
        await this.topUp(this.autoTopUp.amount || 10)
        return this.requestRaw(path, options)
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
        code: data?.code,
      })
    }

    this.updateBalance(response)
    return response
  }

  /**
   * Make an authenticated JSON request to the API.
   * Sets Content-Type for requests with a body. Handles 429 retries and 402 auto top-up.
   */
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers as Record<string, string>),
    }
    const response = await this.requestRaw(path, { ...options, headers })
    return response.json()
  }

  /** List available models */
  async models(): Promise<ModelsResponse> {
    return this.request('/api/v1/models')
  }

  /** Create a chat completion */
  async chat(params: ChatParams): Promise<ChatResponse> {
    if (params.stream) {
      throw new VeniceError('INVALID_PARAMS', 'Use chatStream() for streaming responses')
    }
    return this.request('/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /**
   * Create a streaming chat completion.
   * Returns an async iterator of delta content.
   * Handles 429 retries and 402 auto top-up on the initial request.
   *
   * @example
   * ```typescript
   * for await (const chunk of venice.chatStream({ model: 'llama-3.3-70b', messages })) {
   *   process.stdout.write(chunk)
   * }
   * ```
   */
  async *chatStream(params: Omit<ChatParams, 'stream'>): AsyncGenerator<string, void, unknown> {
    const response = await this.requestRaw('/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, stream: true }),
    })

    const reader = response.body?.getReader()
    if (!reader) {
      throw new VeniceError('STREAM_ERROR', 'No response body')
    }

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
          try {
            const json = JSON.parse(line.slice(6))
            const content = json.choices?.[0]?.delta?.content
            if (content) yield content
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
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
    diemBalanceUsd: number
    canConsume: boolean
    minimumTopUpUsd: number
    suggestedTopUpUsd: number
  }> {
    const response = await this.requestRaw(`/api/v1/x402/balance/${this.address}`)
    const data = await response.json()
    this._balance = data.data.balanceUsd
    return data.data
  }

  /** Fetch x402 transaction history for the current wallet */
  async getTransactions(options: { limit?: number; offset?: number } = {}): Promise<X402TransactionsResponse> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.offset !== undefined) query.set('offset', String(options.offset))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const response = await this.requestRaw(`/api/v1/x402/transactions/${this.address}${suffix}`)
    const data = await response.json()
    return data.data
  }

  /** Top up balance with USDC on Base */
  async topUp(amountUsd: number): Promise<void> {
    if (amountUsd <= 0) {
      throw new VeniceError('INVALID_AMOUNT', 'Top-up amount must be positive')
    }

    // Step 1: Get payment requirements (no auth — expects 402 with x402 accepts)
    const reqResponse = await fetch(`${this.apiUrl}/api/v1/x402/top-up`, {
      method: 'POST',
    })

    if (reqResponse.status !== 402) {
      const data = await this.safeJson(reqResponse)
      throw new VeniceError('TOP_UP_ERROR', data?.error || 'Failed to get payment requirements')
    }

    const requirements = await parseTopUpRequirements(reqResponse)
    const paymentRequirement = selectTopUpRequirement(requirements.accepts)
    const minimumAmountUsd = parseBaseUnitsToUsd(paymentRequirement.amount)

    if (amountUsd < minimumAmountUsd) {
      throw new VeniceError('INVALID_AMOUNT', `Top-up amount must be at least $${minimumAmountUsd.toFixed(2)}`, {
        minimumAmount: minimumAmountUsd,
        requestedAmount: amountUsd,
      })
    }

    // Step 2: Sign and submit payment
    const paymentHeader = await this.signer.signPayment(
      buildSdkPaymentRequirements(this.apiUrl, paymentRequirement, amountUsd),
      requirements.x402Version,
    )

    const payResponse = await fetch(`${this.apiUrl}/api/v1/x402/top-up`, {
      method: 'POST',
      headers: {
        'X-402-Payment': paymentHeader,
      },
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

  private async safeJson(response: Response): Promise<{ error?: string; code?: string; currentBalanceUsd?: number; suggestedTopUpUsd?: number } | null> {
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
  async generate(params: ImageGenerateParams): Promise<ImageResponse | Blob> {
    return requestJsonOrBlob<ImageResponse>(this.client, '/api/v1/image/generate', {
      method: 'POST',
      ...buildBodyInit(params),
    })
  }

  /** OpenAI-compatible image generations route */
  async generations(params: OpenAiImageGenerateParams): Promise<ImageResponse> {
    return this.client.request('/api/v1/images/generations', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /** Upscale or enhance an image */
  async upscale(params: ImageMutationParams): Promise<ImageMutationResponse> {
    return requestJsonOrBlob<Record<string, unknown>>(this.client, '/api/v1/image/upscale', {
      method: 'POST',
      ...buildBodyInit(params),
    })
  }

  /** Edit an image */
  async edit(params: ImageMutationParams): Promise<ImageMutationResponse> {
    return requestJsonOrBlob<Record<string, unknown>>(this.client, '/api/v1/image/edit', {
      method: 'POST',
      ...buildBodyInit(params),
    })
  }

  /** Multi-edit an image */
  async multiEdit(params: ImageMutationParams): Promise<ImageMutationResponse> {
    return requestJsonOrBlob<Record<string, unknown>>(this.client, '/api/v1/image/multi-edit', {
      method: 'POST',
      ...buildBodyInit(params),
    })
  }

  /** Remove image background */
  async backgroundRemove(params: ImageMutationParams): Promise<ImageMutationResponse> {
    return requestJsonOrBlob<Record<string, unknown>>(this.client, '/api/v1/image/background-remove', {
      method: 'POST',
      ...buildBodyInit(params),
    })
  }
}

// =============================================================================
// ResponsesAPI
// =============================================================================

class ResponsesAPI {
  constructor(private readonly client: VeniceClient) {}

  /** Create a Responses API response */
  async create(params: ResponsesParams): Promise<ResponsesResponse> {
    if (params.stream) {
      throw new VeniceError('INVALID_PARAMS', 'Use responses.stream() for streaming responses')
    }

    return this.client.request('/api/v1/responses', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /** Stream a Responses API response */
  async *stream(params: Omit<ResponsesParams, 'stream'>): AsyncGenerator<string, void, unknown> {
    const response = await this.client.requestRaw('/api/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, stream: true }),
    })

    const reader = response.body?.getReader()
    if (!reader) {
      throw new VeniceError('STREAM_ERROR', 'No response body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent: string | null = null

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.length === 0) {
            currentEvent = null
            continue
          }

          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7).trim()
            continue
          }

          if (!trimmed.startsWith('data: ') || trimmed.includes('[DONE]')) continue
          try {
            const json = JSON.parse(trimmed.slice(6)) as Record<string, unknown>

            if (currentEvent === 'response.output_text.delta' && typeof json.delta === 'string') {
              yield json.delta
              continue
            }

            // Fallback for any future payloads that include a materialized output array.
            const output = Array.isArray(json.output) ? json.output : []
            for (const item of output) {
              if (isRecord(item) && item.type === 'message' && Array.isArray(item.content)) {
                for (const content of item.content) {
                  if (isRecord(content) && typeof content.text === 'string') {
                    yield content.text
                  }
                }
              }
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
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
    const response = await this.client.requestRaw('/api/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    return response.blob()
  }

  /** Transcribe audio to text */
  async transcribe(params: TranscribeParams): Promise<TranscribeResult> {
    const formData = new FormData()
    formData.append('model', params.model)
    formData.append('file', toBlob(params.file, params.mimeType), params.filename ?? inferFilename(params.mimeType))
    if (params.language) formData.append('language', params.language)
    if (params.response_format) formData.append('response_format', params.response_format)

    const response = await this.client.requestRaw('/api/v1/audio/transcriptions', {
      method: 'POST',
      body: formData,
    })
    return parseResponseByContentType<TranscribeResponse>(response) as Promise<TranscribeResult>
  }

  /** Queue a new audio generation request */
  async queue(params: AudioQueueParams): Promise<QueueResponse> {
    return this.client.request('/api/v1/audio/queue', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /** Retrieve audio generation status or the completed audio */
  async retrieve(params: AudioRetrieveParams): Promise<MediaRetrieveResponse> {
    return requestJsonOrBlob<MediaRetrieveStatusResponse>(this.client, '/api/v1/audio/retrieve', {
      method: 'POST',
      body: JSON.stringify(params),
      headers: { 'Content-Type': 'application/json' },
    }) as Promise<MediaRetrieveResponse>
  }

  /** Mark an audio generation request as complete and clean up media */
  async complete(params: AudioCompleteParams): Promise<CompletionResponse> {
    return this.client.request('/api/v1/audio/complete', {
      method: 'POST',
      body: JSON.stringify(params),
    })
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
  async retrieve(params: VideoRetrieveParams): Promise<MediaRetrieveResponse> {
    return requestJsonOrBlob<MediaRetrieveStatusResponse>(this.client, '/api/v1/video/retrieve', {
      method: 'POST',
      body: JSON.stringify(params),
      headers: { 'Content-Type': 'application/json' },
    }) as Promise<MediaRetrieveResponse>
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
  ): Promise<Blob> {
    const { queue_id } = await this.queue(params)

    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))

      const result = await this.retrieve({ queue_id })

      if (result instanceof Blob) {
        return result
      }

      if (result.status === 'failed') {
        throw new VeniceError('VIDEO_FAILED', result.error || 'Video generation failed')
      }
    }

    throw new VeniceError('VIDEO_TIMEOUT', `Video generation timed out after ${timeoutMs}ms`)
  }

  /** Mark a video generation request as complete and clean up media */
  async complete(params: VideoCompleteParams): Promise<CompletionResponse> {
    return this.client.request('/api/v1/video/complete', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /** Transcribe video audio from a public URL */
  async transcribe(params: VideoTranscriptionParams): Promise<VideoTranscriptionResponse> {
    return requestJsonTextOrBlob<Record<string, unknown>>(this.client, '/api/v1/video/transcriptions', {
      method: 'POST',
      body: JSON.stringify(params),
      headers: { 'Content-Type': 'application/json' },
    }) as Promise<VideoTranscriptionResponse>
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

function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SIGN_IN_NONCE_BYTES))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function resolveRequestUrl(input: RequestInfo | URL, baseOrigin: string): string {
  if (input instanceof URL) return input.toString()
  if (typeof input === 'string') return new URL(input, baseOrigin).toString()
  return new URL(input.url, baseOrigin).toString()
}

function normalizePaymentNetwork(network: string): SdkPaymentNetwork {
  const normalized = network.trim().toLowerCase()
  if (normalized === 'base-sepolia' || normalized === 'eip155:84532') return 'base-sepolia'
  return 'base'
}

function parseBaseUnitsToUsd(amountBaseUnits: string): number {
  const parsed = parseFloat(amountBaseUnits)
  return Number.isNaN(parsed) ? 0 : parsed / Math.pow(10, USDC_DECIMALS)
}

function buildSdkPaymentRequirements(apiUrl: string, requirement: TopUpAccept, amountUsd: number): SdkPaymentRequirements {
  return {
    scheme: 'exact',
    network: normalizePaymentNetwork(requirement.network),
    maxAmountRequired: String(Math.round(amountUsd * Math.pow(10, USDC_DECIMALS))),
    resource: `${apiUrl}/api/v1/x402/top-up`,
    description: 'Venice x402 top-up',
    mimeType: 'application/json',
    payTo: requirement.payTo,
    maxTimeoutSeconds: 300,
    asset: requirement.asset || USDC_ADDRESS,
    extra: { name: 'USD Coin', version: '2' },
  }
}

function selectTopUpRequirement(accepts: TopUpAccept[]): TopUpAccept {
  const exactBaseUsdc = accepts.find(
    requirement => normalizePaymentNetwork(requirement.network) === 'base' && requirement.asset.toLowerCase() === USDC_ADDRESS.toLowerCase(),
  )
  return exactBaseUsdc ?? accepts[0]
}

async function parseTopUpRequirements(response: Response): Promise<TopUpRequirementsResponse> {
  const body = await safeJson(response)
  if (isTopUpRequirementsResponse(body)) return body

  const encodedHeader = response.headers.get(PAYMENT_REQUIRED_HEADER)
  if (!encodedHeader) {
    throw new VeniceError('TOP_UP_ERROR', 'Missing payment requirements in 402 response')
  }

  try {
    const decoded = Buffer.from(encodedHeader, 'base64').toString('utf8')
    const parsed = JSON.parse(decoded)
    if (isTopUpRequirementsResponse(parsed)) return parsed
  } catch {
    // Fall through to the generic error below.
  }

  throw new VeniceError('TOP_UP_ERROR', 'Invalid payment requirements returned by Venice')
}

function isTopUpRequirementsResponse(value: unknown): value is TopUpRequirementsResponse {
  if (!value || typeof value !== 'object') return false
  const maybe = value as Partial<TopUpRequirementsResponse>
  return typeof maybe.x402Version === 'number' && Array.isArray(maybe.accepts) && maybe.accepts.length > 0
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.clone().json()
  } catch {
    return null
  }
}

function toBlob(file: Blob | Buffer, mimeType?: string): Blob {
  if (file instanceof Blob) {
    if (mimeType && file.type !== mimeType) {
      return new Blob([file], { type: mimeType })
    }
    return file
  }

  return new Blob([new Uint8Array(file)], mimeType ? { type: mimeType } : undefined)
}

function inferFilename(mimeType?: string): string {
  switch (mimeType) {
    case 'audio/wav':
    case 'audio/x-wav':
      return 'audio.wav'
    case 'audio/mpeg':
      return 'audio.mp3'
    case 'audio/flac':
      return 'audio.flac'
    case 'audio/aac':
      return 'audio.aac'
    case 'audio/ogg':
      return 'audio.ogg'
    case 'audio/webm':
      return 'audio.webm'
    case 'audio/mp4':
      return 'audio.m4a'
    default:
      return 'audio.wav'
  }
}

function buildBodyInit(body: object | FormData): Pick<RequestInit, 'body' | 'headers'> {
  if (body instanceof FormData) {
    return { body }
  }

  return {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }
}

async function requestJsonTextOrBlob<T>(
  client: VeniceClient,
  path: string,
  options: RequestInit,
): Promise<T | string | Blob> {
  const response = await client.requestRaw(path, options)
  return parseResponseByContentType<T>(response)
}

async function requestJsonOrBlob<T>(
  client: VeniceClient,
  path: string,
  options: RequestInit,
): Promise<T | Blob> {
  const response = await client.requestRaw(path, options)
  return parseJsonOrBlob<T>(response)
}

async function parseResponseByContentType<T>(response: Response): Promise<T | string | Blob> {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    return response.json()
  }

  if (contentType.startsWith('text/')) {
    return response.text()
  }

  return response.blob()
}

async function parseJsonOrBlob<T>(response: Response): Promise<T | Blob> {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    return response.json()
  }

  return response.blob()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

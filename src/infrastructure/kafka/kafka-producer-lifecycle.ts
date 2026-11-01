export interface KafkaJsMessage {
  readonly key?: Buffer | string | null;
  readonly value: Buffer | string;
  readonly headers?: Readonly<
    Record<string, Buffer | string | readonly (Buffer | string)[] | undefined>
  >;
}

export interface KafkaJsProducerSendOptions {
  readonly topic: string;
  readonly messages: readonly KafkaJsMessage[];
  readonly acks?: number;
}

/** Минимальная граница KafkaJS, пригодная для подмены в модульных проверках. */
export interface KafkaJsProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(options: KafkaJsProducerSendOptions): Promise<unknown>;
  /** Уведомления об отказах, пришедших после разрешения send (например, из error-события клиента). */
  onLateFailure?(listener: (error: unknown) => void): () => void;
}

export class ProducerConnectionError extends Error {
  readonly reason: 'client' | 'broker';

  constructor(reason: 'client' | 'broker') {
    super(`Kafka producer connection failed: ${reason}`);
    this.name = 'ProducerConnectionError';
    this.reason = reason;
  }
}

export interface NativeProducer {
  readonly ready: boolean;
  ensureConnected(): Promise<void>;
  disconnect(): Promise<void>;
  readonly producer: KafkaJsProducerLike;
}

function connectionReason(error: unknown): 'client' | 'broker' {
  if (error instanceof ProducerConnectionError) return error.reason;
  if (typeof error === 'object' && error !== null) {
    const reason = (error as { readonly reason?: unknown }).reason;
    if (reason === 'client' || reason === 'broker') return reason;
  }
  return 'broker';
}

/** Создаёт один продюсер и управляет его подключением и закрытием. */
export function createNativeProducer(options: {
  readonly cluster: { readonly host: string; readonly port: number };
  readonly createProducer: () => KafkaJsProducerLike;
}): NativeProducer {
  // Адрес используется фабрикой, переданной вызывающим слоем; здесь транспорт не создаётся.
  void options.cluster;
  const producer = options.createProducer();
  let isReady = false;
  let isClosed = false;
  let connectionPromise: Promise<void> | undefined;
  let disconnectPromise: Promise<void> | undefined;

  const ensureConnected = (): Promise<void> => {
    if (isReady) return Promise.resolve();
    if (connectionPromise !== undefined) return connectionPromise;
    if (disconnectPromise !== undefined) {
      return disconnectPromise.then(() => ensureConnected());
    }

    isClosed = false;
    const attempt = Promise.resolve()
      .then(() => producer.connect())
      .then(
        () => {
          isReady = true;
        },
        (error: unknown) => {
          isReady = false;
          throw new ProducerConnectionError(connectionReason(error));
        },
      );
    connectionPromise = attempt;
    void attempt.then(
      () => {
        if (connectionPromise === attempt) connectionPromise = undefined;
      },
      () => {
        if (connectionPromise === attempt) connectionPromise = undefined;
      },
    );
    return attempt;
  };

  const disconnect = (): Promise<void> => {
    if (disconnectPromise !== undefined) return disconnectPromise;
    if (isClosed) return Promise.resolve();

    const attempt = (async (): Promise<void> => {
      const activeConnection = connectionPromise;
      if (activeConnection !== undefined) {
        try {
          await activeConnection;
        } catch {
          // Даже после отказа подключения ресурс должен получить попытку закрытия.
        }
      }
      isReady = false;
      await producer.disconnect();
      isClosed = true;
      isReady = false;
    })();
    disconnectPromise = attempt;
    void attempt.then(
      () => {
        if (disconnectPromise === attempt) disconnectPromise = undefined;
      },
      () => {
        if (disconnectPromise === attempt) disconnectPromise = undefined;
      },
    );
    return attempt;
  };

  return {
    get ready(): boolean {
      return isReady;
    },
    ensureConnected,
    disconnect,
    producer,
  };
}

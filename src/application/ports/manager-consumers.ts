import type { ConsumerReservation } from '../../domain/consumer.js';

/** Имя группы получает из отдельного компонента «Имя группы консюмеров»; в резервировании оно не хранится. */
export interface ConsumerManagerPort {
  reserve(topic: string, autoDeleteSeconds: number): Promise<ConsumerReservation>;
  release(reservation: ConsumerReservation): Promise<void>;
  ensureReady(topic: string): Promise<void>;
}

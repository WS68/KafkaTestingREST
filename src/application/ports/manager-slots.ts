import type {
  CheckAccumulator,
  CompiledCheck,
  Slot,
  SlotId,
  WaitRequest,
} from '../../domain/index.js';
import type {
  CountResult,
  ReadResult,
  SlotDeletionResult,
  SlotRegistrationResult,
  WaitResult,
} from '../results/index.js';

export interface RegisterSlotCommand {
  readonly topic: string;
  readonly autoDeleteSeconds: number | undefined;
  readonly checks: readonly CompiledCheck[];
}

export interface RegisteredSlot {
  readonly slot: Slot;
  readonly accumulators: readonly CheckAccumulator[];
}

/** Только чтение активного состояния, необходимого обработчику записей и маршрутизации (задачи 45/57). */
export interface ActiveSlotsPort {
  snapshot(topic: string): readonly RegisteredSlot[];
}

/** Реализация зависит от менеджера консюмеров только через ConsumerManagerPort, без обратной ссылки. */
export interface SlotManagerPort {
  register(request: RegisterSlotCommand): Promise<SlotRegistrationResult>;
  delete(slotId: SlotId): Promise<SlotDeletionResult>;
  count(slotId: SlotId, checkIndex: number): Promise<CountResult>;
  read(slotId: SlotId, checkIndex: number, offset: number, count: number): Promise<ReadResult>;
  wait(request: WaitRequest): Promise<WaitResult>;
}

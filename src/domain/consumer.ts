/** Машинные состояния жизненного цикла консюмера: отсутствует, создаётся, очищается после сбоя, готов, закрывается или удаляет группу. */
export type ConsumerLifecycleState =
  'absent' | 'creating' | 'cleaning-failed-creation' | 'ready' | 'closing' | 'deleting-group';

export interface ConsumerGeneration {
  readonly generation: number;
  readonly state: ConsumerLifecycleState;
  readonly expiresAt: number;
}

export interface ConsumerReservation {
  readonly topic: string;
  readonly generation: number;
}

/**
 * Состояния слота: активен без ожиданий, активен с ожиданиями, удалён по сроку
 * или удалён вручную; соответствуют разделам о жизненном цикле слота.
 */
export type SlotLifecycleState =
  'active-idle' | 'active-waiting' | 'deleted-by-expiry' | 'deleted-manually';

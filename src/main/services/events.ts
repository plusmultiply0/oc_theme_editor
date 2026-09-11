/**
 * 操作进度事件广播（T15）。
 *
 * 主进程把阶段事件推给所有窗口；renderer 不轮询，也不自己拼百分比。
 * 只在能量化进度时给 percent，给不出就不给——编一个假的进度条没有意义。
 */
import type { OperationEvent } from '../../shared/schema';

export type EventSender = (event: OperationEvent) => void;

export class OperationEventBus {
  private readonly senders = new Set<EventSender>();

  subscribe(fn: EventSender): () => void {
    this.senders.add(fn);
    return () => {
      this.senders.delete(fn);
    };
  }

  emit(event: OperationEvent): void {
    for (const send of this.senders) {
      try {
        send(event);
      } catch {
        // 事件推送失败不能影响事务本身
      }
    }
  }
}

export enum IngestionState {
  PENDING = 'PENDING',
  TENTATIVE = 'TENTATIVE',
  SETTLED = 'SETTLED',
  ROLLED_BACK = 'ROLLED_BACK',
  RECONCILING = 'RECONCILING',
  FAILED = 'FAILED',
}

export interface StateTransition {
  from: IngestionState;
  to: IngestionState;
  timestamp: number;
  reason: string;
}

const VALID_TRANSITIONS: Record<IngestionState, IngestionState[]> = {
  [IngestionState.PENDING]: [IngestionState.TENTATIVE, IngestionState.FAILED],
  [IngestionState.TENTATIVE]: [
    IngestionState.SETTLED,
    IngestionState.ROLLED_BACK,
    IngestionState.FAILED,
  ],
  [IngestionState.SETTLED]: [],
  [IngestionState.ROLLED_BACK]: [IngestionState.RECONCILING],
  [IngestionState.RECONCILING]: [IngestionState.PENDING, IngestionState.FAILED],
  [IngestionState.FAILED]: [],
};

export class IngestionStateMachine {
  private state: IngestionState;
  private history: StateTransition[] = [];

  constructor(initialState: IngestionState = IngestionState.PENDING) {
    this.state = initialState;
  }

  transition(to: IngestionState, reason: string): boolean {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(to)) {
      return false;
    }
    this.history.push({
      from: this.state,
      to,
      timestamp: Date.now(),
      reason,
    });
    this.state = to;
    return true;
  }

  getState(): IngestionState {
    return this.state;
  }

  getHistory(): StateTransition[] {
    return [...this.history];
  }

  canTransitionTo(state: IngestionState): boolean {
    return VALID_TRANSITIONS[this.state].includes(state);
  }
}

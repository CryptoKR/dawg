
import { peek, Disposer, reverse } from '@/lib/std';
import Vue from 'vue';
import { reactive } from '@vue/composition-api';
import { emitter } from '@/lib/events';
import { getLogger } from '@/lib/log';

const logger = getLogger('olyger');

// You can read more about this file in the following issue:
// https://github.com/dawg/dawg/issues/156

// This is from the composition API
// We should probably remove this but idk
const RefKey = 'vfa.key.refKey';

interface Command<T> {
  id: number;
  name: string;
  execute: () => T;
  emit: (o: T) => void;
  undo: () => void;
  subscriptions: Subscription[];
}

interface ExecutedCommand<T> extends Command<T> {
  undoers: Array<ReturnType<Subscription['execute']>>;
}

export const genId = ((i) => () => i++)(0);

export interface ExecutedAction<T> {
  id: number;
  commands: Array<ExecutedCommand<T>>;
}

export interface Action<T> {
  id: number;
  commands: Array<Command<T>>;
}

interface Context {
  reference?: Action<any>;
  top?: Action<any>;
  hasUnsavedChanged: boolean;
}

const undoHistory: Array<ExecutedAction<any>> = [];
const redoHistory: Array<Action<any>> = [];
const context: Context = {
  reference: undefined,
  top: undefined,
  hasUnsavedChanged: false,
};

export const undoStack: Readonly<Array<ExecutedAction<any>>> = undoHistory;
export const redoStack: Readonly<Array<Action<any>>> = redoHistory;
export const undoRedoContext: Readonly<Context> = context;

type State = 'unsaved' | 'saved';
const stateChangeEvents = emitter<{ stateChange: [State] }>();

export const onDidStateChange = (cb: (state: State) => void) => {
  return stateChangeEvents.on('stateChange', cb);
};

const setValue = (key: 'reference' | 'top', a: Action<any> | undefined) => {
  context[key] = a;

  const oldValue = context.hasUnsavedChanged;
  const newValue = context.hasUnsavedChanged = context.reference !== context.top;
  if (oldValue !== newValue) {
    stateChangeEvents.emit('stateChange', newValue ? 'unsaved' : 'saved');
  }
};

let action: ExecutedAction<any> | undefined;

// Beware we group ALL actions together even if they are different actions
// This works well for now but may not be desirable in future use cases
let group: { action: ExecutedAction<any> } | undefined;

const getOrCreateExecutionContext = () => {
  let startOfExecution = false;
  let startOfGroupedExecution = false;
  if (!action) {
    if (group) {
      startOfGroupedExecution = true;
      action = group.action;
    } else {
      startOfExecution = true;
      action = { commands: [], id: genId() };
      group = { action };
      setTimeout(() => {
        group = undefined;
      }, 500);
    }
  }

  // create a local copy which is not undefined
  const local = action;

  const execute = <T>(command: Command<T>) => {
    const result = command.execute();
    command.emit(result);
    local.commands.push({
      ...command,
      undoers: command.subscriptions.map((subscription) => subscription.execute()),
    });

    return result;
  };

  if (startOfGroupedExecution) {
    return {
      execute,
      finish: () => {
        action = undefined;
      },
    };
  }

  if (!startOfExecution) {
    return {
      execute,
      finish: () => {
        // do nothing
      },
    };
  }

  return {
    execute,
    finish: () => {
      undoHistory.push(local);
      setValue('top', local);

      // Everything in the redo stack is going to be lost forever at this point
      // If needed, subscriptions can have a dispose method for cleaning up after themselves
      redoHistory.forEach((a) => {
        a.commands.forEach((command) => {
          command.subscriptions.forEach((subscription) => {
            if (subscription.dispose) {
              subscription.dispose();
            }
          });
        });
      });

      redoHistory.splice(0, redoHistory.length);
      action = undefined;

      logger.debug(
        `Executed -> ${local.commands.map((c) => c.name).join(', ')} [${undoHistory.length}, ${redoHistory.length}]`,
      );
    },
  };
};



export const undo = (): 'empty' | 'performed' => {
  const undoTop = undoHistory.pop();
  if (!undoTop) {
    return 'empty';
  }

  for (const command of reverse(undoTop.commands)) {
    command.undo();
    command.undoers.forEach((undoer) => undoer.undo());
  }

  redoHistory.push(undoTop);
  setValue('top', peek(undoHistory));
  context.hasUnsavedChanged = context.top !== context.reference;

  logger.debug(
    `Undid -> ${undoTop.commands.map((c) => c.name).join(', ')} [${undoHistory.length}, ${redoHistory.length}]`,
  );

  return 'performed';
};

export const redo = (): 'empty' | 'performed' => {
  const redoTop = redoHistory.pop();
  if (!redoTop) {
    return 'empty';
  }

  for (const command of redoTop.commands) {
    command.execute();
  }

  undoHistory.push({
    id: redoTop.id,
    commands: redoTop.commands.map((command) => {
      return {
        ...command,
        undoers: command.subscriptions.map((subscription) => subscription.execute()),
      };
    }),
  });

  setValue('top', redoTop);

  logger.debug(
    `Redid -> ${redoTop.commands.map((c) => c.name).join(', ')} [${undoHistory.length}, ${redoHistory.length}]`,
  );

  return 'performed';
};

export const freezeReference = () => {
  setValue('reference', peek(undoHistory));
};

function proxy<T, V>(
  target: V, { get, set }: GetSet<T>,
): V & { value: T } {
  Object.defineProperty(target, 'value', {
    enumerable: true,
    configurable: true,
    get,
    set,
  });
  return target as V & { value: T };
}

interface GetSet<T> {
  get(): T;
  set(x: T): void;
}

interface Ref<T> {
  value: T;
}

interface Subscription {
  execute: () => { undo: () => void };
  /**
   * This is called for cleaning up purposes. At this point, we will never call the subscription again.
   */
  dispose?: () => void;
}

type Undo = () => void;
type Execute = () => Undo | Disposer[] | Disposer;

interface ElementChangeContext<T> {
  newValue: T;
  oldValue: T;
  onExecute: (cb: Execute) => void;
  subscriptions: Subscription[];
}

interface ElementChaining<T> {
  onDidChange: (cb: (o: ElementChangeContext<T>) => void) => Disposer;
}

const onExecuteHelper = (subscriptions: Subscription[]) => {
  return (cb: Execute) => {
    subscriptions.push({
      execute: () => {
        const result = cb();
        if (typeof result === 'function') {
          return {
            undo: result,
          };
        }

        if (Array.isArray(result)) {
          return {
            undo: () => {
              result.forEach((disposer) => disposer.dispose());
            },
          };
        }

        return {
          undo: () => {
            result.dispose();
          },
        };
      },
    });
  };
};

export type OlyRef<T> = Ref<T> & ElementChaining<T>;

export function olyRef<T>(raw: T, name?: string): Ref<T> & ElementChaining<T> {
  const o = reactive({ [RefKey]: raw }) as { [RefKey]: T };
  const id = genId();

  const events = emitter<{ change: [ElementChangeContext<T>] }>();

  const ref = proxy({}, {
    get: () => o[RefKey],
    set: (v) => {
      const oldValue = o[RefKey];

      const subscriptions: Subscription[] = [];
      const onExecute = onExecuteHelper(subscriptions);

      // This is important as it prevents a command being placed on the stack
      if (oldValue === v) {
        return;
      }

      const env = getOrCreateExecutionContext();
      env.execute({
        id,
        name: `Set${name ? ` ${name}` : ''} to ${v}`,
        subscriptions,
        execute: () => {
          o[RefKey] = v;
        },
        emit: () => {
          events.emit('change', { newValue: v, oldValue, subscriptions, onExecute });
        },
        undo: () => {
          o[RefKey] = oldValue;
        },
      });

      env.finish();
    },
  });

  const chaining: ElementChaining<T> = {
    onDidChange: (cb) => events.on('change', cb),
  };

  return Object.assign(ref, chaining);
}

interface Items<T> {
  items: T[];
  startingIndex: number;
  onExecute: (cb: Execute) => void;
  subscriptions: Subscription[];
}

interface ArrayChaining<T> {
  onDidAdd: (cb: (o: Items<T>) => void) => Disposer;
  onDidRemove: (cb: (o: Items<T>) => void) => Disposer;
}

export type OlyArr<T> = T[] & ArrayChaining<T>;

export const olyArr = <T>(raw: T[], name: string): OlyArr<T> => {
  // Explicitly make the array observable because we replace some of the methods
  // We store local variables in this closure and these NEED to be the vue ones for reactivity
  // Therefore, we make the following call
  raw = Vue.observable(raw);

  const events = emitter<{ add: [Items<T>], remove: [Items<T>] }>();

  const push = raw.push.bind(raw);
  const splice = raw.splice.bind(raw);

  const pushId = genId();
  const spliceId = genId();

  raw.push = (...items) => {
    const length = raw.length;
    const subscriptions: Subscription[] = [];
    const onExecute = onExecuteHelper(subscriptions);
    const env = getOrCreateExecutionContext();

    const commandName = items.length === 1 ?
      `Added ${name}` :
      `Added ${items.length} ${items.length}s`;

    const addedLength = env.execute({
      id: pushId,
      name: commandName,
      subscriptions,
      execute: () => {
        const result = push(...items);
        return result;
      },
      emit: () => {
        events.emit('add', { items, startingIndex: length, subscriptions, onExecute });
      },
      undo: () => {
        splice(length, items.length);
      },
    });

    env.finish();

    return addedLength;
  };

  raw.splice = (start: number, deleteCount: number, ...items: T[]) => {
    if (!deleteCount && items.length === 0) {
      return [];
    }

    const subscriptions: Subscription[] = [];
    const onExecute = onExecuteHelper(subscriptions);
    const env = getOrCreateExecutionContext();

    let commandName = '';
    if (items.length === 1) {
      commandName += `Added ${name}`;
    } else if (items.length > 1) {
      commandName += `Added ${items.length} ${name}s`;
    }

    if (deleteCount === 1) {
      commandName += commandName ?
        ` and Deleted ${name}` :
        `Deleted ${name}`;
    } else if (deleteCount > 1) {
      commandName += commandName ?
        ` and Deleted ${deleteCount} ${name}s` :
        `Deleted ${deleteCount} ${name}s`;
    }

    const deleted: T[] = env.execute({
      id: spliceId,
      name: commandName,
      subscriptions,
      execute: () => {
        const result = splice(start, deleteCount, ...items);
        return result;
      },
      emit(result) {
        events.emit('remove', { items: result, startingIndex: start, subscriptions, onExecute });
        events.emit('add', { items, startingIndex: start, subscriptions, onExecute });
      },
      undo: () => {
        splice(start, items.length, ...deleted);
      },
    });

    env.finish();

    return deleted;
  };

  const chaining: ArrayChaining<T> = {
    onDidAdd: (f) => events.on('add', f),
    onDidRemove: (f) => events.on('remove', f),
  };

  return Object.assign(
    raw,
    chaining,
  );
};

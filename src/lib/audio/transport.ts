import { createTimeline } from '@/lib/audio/timeline';
import { ContextTime, Ticks, Seconds, Beat, BPM } from '@/lib/audio/types';
import { createClock } from '@/lib/audio/clock';
import { emitter } from '@/lib/events';
import { Disposer } from '@/lib/std';
import { getContext } from '@/lib/audio/global';
import { setter, getter, Setter, Getter } from '@/lib/reactor';
import { PlaybackState } from '@/lib/audio/state-timeline';

interface EventContext {
  seconds: ContextTime;
  ticks: Ticks;
}

interface SchedulingContext {
  time: Beat;
  duration: Beat;
  row: number;
}

type Filter = (event: TransportEvent) => boolean;

// FIXME Ok so this type definition is not 100% correct as the duration does not NEED to be defined iff onEnd AND onTick
// are undefined.
export interface TransportEvent {
  time: Ticks;
  // Must be defined if `onMidStart` OR `onEnd` OR `onTick` are defined
  duration: Ticks;
  offset: Ticks;
  // This is kinda irrelevant and should maybe be removed
  // But it was definitely the easiest solution to implementing row muting
  // The reason this isn't the best is that the transport shouldn't really care about rows but if you can find a
  // better solution then we can remove this
  row: number;
  // Called ONLY at the start of the event
  onStart?: (context: EventContext) => void;
  // Called when the event is started at ANY point during its duration, EXCLUDING the start
  onMidStart?: (context: { seconds: ContextTime, ticks: Ticks, secondsOffset: Seconds, ticksOffset: Ticks }) => void;
  // Called when the event is finished. This includes at the end its end time, when the clock is paused, when the
  // the clock is stopped, if the event is suddenly rescheduled such that the end time is less than the current time
  // or if the event is suddenly rescheduled such that the start time is after the current time.
  onEnd?: (context: EventContext) => void;
  // Called on each tick while the event is active (when the current time >= start time AND the current time <= start
  // time + duration).
  onTick?: (context: EventContext) => void;
}

export interface TransportEventController {
  setStartTime(startTime: Beat): void;
  setOffset(offset: Beat): void;
  setRow(row: number): void;
  setDuration(duration: Beat): void;
  remove(): Disposer;
}

export interface ObeoTransport extends Disposer {
  readonly loopStart: Setter<Beat>;
  readonly loopEnd: Setter<Beat>;
  readonly ticks: Setter<Ticks>;
  readonly beat: Setter<Beat>;
  readonly bpm: Setter<BPM>;
  readonly seconds: Getter<Seconds>;
  readonly state: Getter<PlaybackState>;
  start(): void;
  stop(): void;
  pause(): void;
  addFilter(filter: Filter): void;
  /**
   * Schedule an event.
   */
  schedule(event: TransportEvent): TransportEventController;
  embedIn(parent: ObeoTransport, context: SchedulingContext): TransportEventController;
}

export const createTransport = (): ObeoTransport => {
  let startPosition: Ticks = 0;
  const timeline = createTimeline<TransportEvent>();
  let active: TransportEvent[] = [];
  let isFirstTick = true;
  const filters: Array<(event: TransportEvent) => boolean> = [];
  const events = emitter<{ beforeStart: [EventContext], beforeEnd: [EventContext] }>();

  // tslint:disable-next-line:variable-name
  let _loopStart: Ticks = 0;
  // tslint:disable-next-line:variable-name
  let _loopEnd: Ticks = 0;

  const processTick = (seconds: ContextTime, currentTick: Ticks, isChild = false) => {
    if (!isChild && currentTick >= _loopEnd) {
      events.emit('beforeEnd', { seconds, ticks: currentTick });
      checkOnEndEventsAndResetActive({ seconds, ticks: currentTick });
      clock.setTicksAtTime(_loopStart, seconds);
      currentTick = _loopStart;
      isFirstTick = true;
    }

    if (isFirstTick) {
      events.emit('beforeStart', { seconds, ticks: currentTick });

      // The upper bound is exclusive but we don't care about checking about events that haven't started yet.
      timeline.forEachBetween(0, currentTick, (event) => {
        if (doFilter(event)) {
          return;
        }

        // Check if it's already finished
        if (event.time + event.duration < currentTick) {
          return;
        }

        checkMidStart(event, {
          seconds,
          ticks: currentTick,
        });

        // Again, we DON't CARE about event that don't need to ba called again
        if (event.onTick || event.onEnd) {
          active.push(event);
        }
      });
      isFirstTick = false;
    }

    // Invoke onTick callbacks for events scheduled on this tick.
    // Also, add them to the active list of events if required.
    timeline.forEachAtTime(currentTick, (event) => {
      if (doFilter(event)) {
        return;
      }

      if (event.onStart) {
        event.onStart({
          seconds,
          ticks: currentTick,
        });
      }

      // If neither of these is defined then we don't really care about it anymore
      if (event.onTick || event.onEnd) {
        active.push(event);
      }
    });

    active = active.filter((event) => {
      if (doFilter(event)) {
        if (event.onEnd) { event.onEnd({ seconds, ticks: currentTick }); }
        return false;
      }

      const endTime = event.time + event.duration;
      const startTime = event.time + event.offset;
      if (endTime < currentTick) {
        // This occurs if the start time was reduced or the duration was reduced such that the end time became less
        // than the current time.
        if (event.onEnd) { event.onEnd({ seconds, ticks: currentTick }); }
      } else if (endTime === currentTick) {
        // If we've reached the end of the event than still call onTick and then onEnd as well.
        if (event.onTick) { event.onTick({ seconds, ticks: currentTick }); }
        if (event.onEnd) { event.onEnd({ seconds, ticks: currentTick }); }
      } else if (startTime > currentTick) {
        // This can happen if the event is rescheduled such that it starts after the current time
        if (event.onEnd) { event.onEnd({ seconds, ticks: currentTick }); }
      } else {
        if (event.onTick) { event.onTick({ seconds, ticks: currentTick }); }
      }

      // Keep iff the end time has not passed and the start time has passed
      return currentTick < endTime && startTime <= currentTick;
    });
  };

  const clock = createClock(processTick, {
    frequency: 0,
  });

  const disposers: Disposer[] = [];
  const context = getContext();

  // TODO TODO
  // const setBpm = () => {
  //   clock.frequency.offset.value = 1 / (60 / context.BPM.value / context.PPQ.value);
  // };

  const bpm = setter(
    () => clock.frequency.offset.value * 60 / context.PPQ.value,
    (value) => clock.frequency.offset.value = 1 / (60 / value / context.PPQ.value),
  );

  // TODO this should be handled by the project, not ..
  // disposers.push(context.BPM.onDidChange(setBpm));

  disposers.push(clock.onDidStop((o) => {
    checkOnEndEventsAndResetActive(o);
  }));


  const schedule = (event: TransportEvent): TransportEventController => {
    // make a copy so setting values does nothing
    event = {
      ...event,
      // FIXME we probably shouldn't be converting to beats here??
      duration: context.beatsToTicks(event.duration),
      time: context.beatsToTicks(event.time),
      offset: context.beatsToTicks(event.offset),
    };
    timeline.add(event);

    const checkNowActive = () => {
      if (state.value !== 'started') {
        return;
      }

      if (doFilter(event)) {
        return;
      }

      // If the event hasn't started yet or if it has already ended, we don't care
      const current = clock.getTicks();
      const startTime = event.time + event.offset;
      const endTime = startTime + event.duration;
      if (
        startTime > current ||
        endTime < current
      ) {
        return;
      }

      // If it's already in there, we don't need to add it
      const index = active.indexOf(event);
      if (index !== -1) {
        return;
      }

      // Ok now we now that the event needs to be retroactively added to the active list
      if (event.onTick || event.onEnd) {
        active.push(event);
      }

      // Ok so we the event is now active, but we have to make sure to call the correct function
      if (startTime === current) {
        if (event.onStart) {
          event.onStart({
            seconds: context.now(),
            ticks: clock.getTicks(),
          });
        }
      } else {
        checkMidStart(event, {
          seconds: context.now(),
          ticks: clock.getTicks(),
        });
      }
    };

    let added = true;
    return {
      setStartTime: (startTime: Beat) => {
        event.time = context.beatsToTicks(startTime);
        // So we need to reposition the element in the sorted array after setting the time
        // This is a very simple way to do it but it could be done more efficiently
        const didRemove = timeline.remove(event);

        // It may be the case that the element is not scheduled so we need to take that into consideration
        if (didRemove) {
          timeline.add(event);
        }
        checkNowActive();
      },
      setDuration: (duration: Beat) => {
        event.duration = context.beatsToTicks(duration);
        checkNowActive();
      },
      setRow: (row: number) => {
        event.row = row;
      },
      setOffset: (offset: Beat) => {
        event.offset = context.beatsToTicks(offset);
        // We also need to make sure it's sorted here
        timeline.remove(event);
        timeline.add(event);
        checkNowActive();
      },
      remove: () => {
        if (!added) {
          return {
            dispose: () => {
              //
            },
          };
        }

        timeline.remove(event);
        added = false;

        const disposeEvent = () => {
          timeline.add(event);
          added = true;

          checkNowActive();
        };

        if (!active) {
          return {
            dispose: disposeEvent,
          };
        }

        const i = active.indexOf(event);
        if (i >= 0) {
          if (event.onEnd) {
            event.onEnd({
              ticks: clock.getTicks(),
              seconds: context.now(),
            });
          }

          active.splice(i, 1);
        }

        return {
          dispose: disposeEvent,
        };
      },
    };
  };

  const embedIn = (parent: ObeoTransport, o: { time: Beat, duration: Beat, row: number }) => {
    return parent.schedule({
      onStart: () => {
        isFirstTick = true;
      },
      onMidStart: () => {
        isFirstTick = true;
      },
      onTick({ seconds, ticks: currentTick }) {
        // We subtract the `tick` value because the given transport is positioned relative to this transport.
        // For example, if we embed transport A in transport B at tick 1 and the callback is called at tick 2, we want
        // transport A to think it is time tick 1
        processTick(seconds, currentTick - this.time, true);
      },
      time: o.time,
      offset: 0,
      duration: o.duration,
      row: o.row,
    });
  };

  /**
   * Filter out events during playback.
   *
   * @param filter The filter function. It should return false if the event should be ignored.
   */
  const addFilter = (filter: Filter) => {
    filters.push(filter);

    return {
      dispose: () => {
        const i = filters.indexOf(filter);

        if (i >= 0) {
          filters.splice(i, 1);
        }
      },
    };
  };

  /**
   * Start playback from current position.
   */
  const start = () => {
    isFirstTick = true;
    clock.start();
  };

  /**
   * Pause playback.
   */
  const pause = () => {
    clock.pause();
  };

  /**
   * Stop playback and return to the beginning.
   */
  const stop = () => {
    clock.stop();
    ticks.value = startPosition;
  };

  const dispose = () => {
    disposers.forEach((disposer) => disposer.dispose());
  };

  const loopStart = setter(
    () => _loopStart / context.PPQ.value,
    (value: Beat) => _loopStart = value * context.PPQ.value,
  );

  const loopEnd = setter(
    () => _loopEnd / context.PPQ.value,
    (value: Beat) => _loopEnd = value * context.PPQ.value,
  );

  const ticks = setter(
    () => clock.getTicks(),
    (t: number) => {
    if (clock.getTicks() !== t) {
      const now = context.now();
      // stop everything synced to the transport
      if (state.value === 'started') {
        // restart it with the new time
        clock.setTicksAtTime(t, now);
      } else {
        clock.setTicksAtTime(t, now);
      }

      startPosition = t;
    }
  });

  const beat = setter(
    () => ticks.value / context.PPQ.value,
    (value: number) => {
    ticks.value = value * context.PPQ.value;
  });

  const state = getter(() => clock.getState());

  const checkMidStart = (event: TransportEvent, c: EventContext) => {
    if (event.onMidStart) {
      const ticksOffset = c.ticks - event.time;
      const secondsOffset = context.ticksToSeconds(ticksOffset);
      event.onMidStart({
        ...c,
        secondsOffset,
        ticksOffset,
      });
    }
  };

  const checkOnEndEventsAndResetActive = (c: EventContext) => {
    active.forEach((event) => {
      if (event.onEnd) {
        event.onEnd(c);
      }
    });
    active = [];
  };

  const doFilter = (event: TransportEvent) => {
    return filters.some((filter) => !filter(event));
  };

  return {
    seconds: getter(() => clock.getSeconds()),
    loopStart,
    loopEnd,
    ticks,
    bpm,
    beat,
    state,
    stop,
    start,
    pause,
    addFilter,
    schedule,
    embedIn,
    dispose,
  };
};

import Tone from 'tone';
import * as t from 'io-ts';
import * as Audio from '@/modules/audio';
import { Instrument, InstrumentType } from '@/core/instrument/instrument';
import { Serializable } from '../serializable';
import { literal } from '@/utils';

export const SynthType = t.intersection([
  t.type({
    instrument: t.literal('synth'),
    type: t.string,
  }),
  InstrumentType,
]);

export type ISynth = t.TypeOf<typeof SynthType>;

export class Synth extends Instrument<Audio.SynthOptions> implements Serializable<ISynth> {
  private oscillatorType: string;

  constructor(i: ISynth) {
    super(new Tone.PolySynth(8, Tone.Synth), i);
    this.oscillatorType = i.type;
    this.type = i.type;
    this.set({ key: 'envelope', value: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 1 } });
  }

  get type() {
    return this.oscillatorType;
  }

  set type(type: string) {
    this.oscillatorType = type;
    this.set({ key: 'oscillator', value: { type } });
  }

  public serialize() {
    return {
      instrument: literal('synth'),
      type: this.oscillatorType,
      volume: this.volume.value,
      pan: this.pan.value,
      name: this.name,
      id: this.id,
      channel: this.channel,
      mute: this.mute,
    };
  }
}


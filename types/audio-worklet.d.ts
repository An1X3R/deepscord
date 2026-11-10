declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, constructor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

import 'react-native-get-random-values'; // MUST BE FIRST
import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import process from 'process';

global.Buffer = Buffer;
global.process = process;

global.Buffer = Buffer;
global.process = process;
global.process.env.NODE_ENV = __DEV__ ? 'development' : 'production';

// simple-peer specifically looks for the 'events' module
// We link the global EventEmitter so it's found when required
if (typeof Uint8Array !== 'undefined') {
  global.Uint8Array = Uint8Array;
}
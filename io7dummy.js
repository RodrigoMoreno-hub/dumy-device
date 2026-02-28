#!/usr/bin/env node
import { setConfigFile, Device } from './io7device.js';
import { existsSync } from 'fs';

if (process.argv.length < 3) {
    console.log('Usage: io7dummy.js  lamp | switch | thermo | lux | ...');
    process.exit(1);
}

let dCodeFile = process.argv[2];

let device = new Device(dCodeFile);

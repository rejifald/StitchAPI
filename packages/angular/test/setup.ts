// One-time Angular test-environment bootstrap (zone.js + the JIT testing
// platform), so `TestBed` works under vitest's node/jsdom runner.
import '@angular/compiler';
import { getTestBed } from '@angular/core/testing';
import {
    BrowserDynamicTestingModule,
    platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import 'zone.js';
import 'zone.js/testing';

getTestBed().initTestEnvironment(
    BrowserDynamicTestingModule,
    platformBrowserDynamicTesting(),
);

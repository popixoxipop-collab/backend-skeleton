import test from 'node:test';
import { checkNativeSourceNotSelfCertified } from './wave6-case-functions.mjs';
test("NEG-GAME-02 source-only native export cannot self-certify causality or runtime behavior", checkNativeSourceNotSelfCertified);

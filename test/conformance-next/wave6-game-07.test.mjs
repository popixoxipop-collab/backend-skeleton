import test from 'node:test';
import { checkUnityExactGuidSourceBinding } from './wave6-case-functions.mjs';
test("NEG-GAME-07 Unity GUID edits invalidate exact artifact binding, never silently reuse old asset identity", checkUnityExactGuidSourceBinding);

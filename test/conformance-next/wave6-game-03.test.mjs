import test from 'node:test';
import { checkGodotSceneScopedIdentity } from './wave6-case-functions.mjs';
test("NEG-GAME-03 equal local names in two scenes preserve distinct source-scoped identities", checkGodotSceneScopedIdentity);

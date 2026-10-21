import test from 'node:test';
import { checkWebgameInputCausalityUnknown } from './wave6-case-functions.mjs';
test("NEG-GAME-01 adjacent input and motion declarations retain unresolved causal effect", checkWebgameInputCausalityUnknown);

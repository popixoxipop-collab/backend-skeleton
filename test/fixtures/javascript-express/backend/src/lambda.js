// The Serverless Framework entry point: a one-line `serverless-http` wrapper around the very same
// `express()` app `npm start` would run locally. Deliberately part of this fixture -- the real
// target shape G6 was found in (an Express app on AWS Lambda, nodejs20.x) reaches Express only
// through this file, and an adapter that keyed on "is there an app.listen()" would miss it
// entirely. This adapter keys on Router structure instead, so this file is scanned and simply
// contributes nothing, which is the correct outcome.
import ServerlessHttp from 'serverless-http';
import app from './app.js';

export const handler = async (event, context) => ServerlessHttp(app)(event, context);

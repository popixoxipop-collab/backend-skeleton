import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

export async function createApp() {
  return NestFactory.create(AppModule, { logger: false });
}

export async function createPrefixedApp() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix(process.env.API_BASE ?? 'svc'); // prefix decided at start-up
  return app;
}

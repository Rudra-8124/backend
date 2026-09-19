import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { AppModule } from '../src/app.module';

async function generateOpenApi() {
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
    logger: false,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Amrutam Telemedicine API')
    .setDescription('Production-grade telemedicine backend')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  const yamlString = YAML.stringify(document);

  const outputPath = path.resolve(__dirname, '../docs/openapi.yaml');
  fs.writeFileSync(outputPath, yamlString, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`OpenAPI specification exported to ${outputPath}`);

  await app.close();
  process.exit(0);
}

generateOpenApi().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to export OpenAPI spec:', err);
  process.exit(1);
});

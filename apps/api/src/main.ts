import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Logger as PinoLogger } from "nestjs-pino";

import { AppModule } from "./app.module";
import {
  AddressChangePayload,
  BankAccountChangePayload,
  SalaryChangePayload,
} from "./events/dto/payloads";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(PinoLogger));
  app.setGlobalPrefix("api");
  app.enableCors();
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Payroll Event Processing Service")
      .setDescription(
        "Accepts payroll change events and processes them asynchronously.",
      )
      .setVersion("1.0")
      .build(),
    {
      // Referenced via $ref from CreateEventDto.payload but not otherwise
      // reachable, so they must be registered explicitly.
      extraModels: [
        BankAccountChangePayload,
        AddressChangePayload,
        SalaryChangePayload,
      ],
    },
  );
  SwaggerModule.setup("api/docs", app, document, {
    jsonDocumentUrl: "api/docs-json",
  });

  const config = app.get(ConfigService);
  const port = config.get<number>("PORT") ?? 3001;
  await app.listen(port, "0.0.0.0");

  app
    .get(PinoLogger)
    .log(`API ready on http://localhost:${port}/api (docs at /api/docs)`);
}

void bootstrap();

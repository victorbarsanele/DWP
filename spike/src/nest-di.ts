import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

@Injectable()
class ProbeService {
  value(): string {
    return "decorators-and-di-ok";
  }
}

@Module({ providers: [ProbeService], exports: [ProbeService] })
class ProbeModule {}

@Module({ imports: [ProbeModule] })
class AppModule {}

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
});
const result = app.get(ProbeService).value();
console.log(result);
await app.close();

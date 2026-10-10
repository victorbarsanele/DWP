import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { mikroOrmOptions } from "./infrastructure/persistence/mikro-orm/mikro-orm.options";

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmOptions())],
})
export class AppModule {}

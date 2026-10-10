import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { mikroOrmOptions } from "./infrastructure/persistence/mikro-orm/mikro-orm.options";
import { ApplicationModule } from "./application/application.module";
import { HttpModule } from "./http/http.module";

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmOptions()), ApplicationModule, HttpModule],
})
export class AppModule {}

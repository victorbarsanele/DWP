import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { mikroOrmOptions } from "./infrastructure/persistence/mikro-orm/mikro-orm.options";
import { ApplicationModule } from "./application/application.module";
import { HttpModule } from "./http/http.module";
import { SqsMessagingModule } from "./infrastructure/messaging/sqs/sqs-messaging.module";

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmOptions()),
    ApplicationModule,
    HttpModule,
    SqsMessagingModule,
  ],
})
export class AppModule {}

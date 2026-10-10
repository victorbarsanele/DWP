import { Module } from "@nestjs/common";
import { ApplicationModule } from "../application/application.module";
import { HttpQueryService } from "./query.service";
import { WalletController } from "./wallet.controller";
import { OperationsController } from "./operations.controller";
import { SqsMessagingModule } from "../infrastructure/messaging/sqs/sqs-messaging.module";
import { ProviderAuthGuard } from "./provider-auth.guard";

@Module({
  imports: [ApplicationModule, SqsMessagingModule],
  controllers: [WalletController, OperationsController],
  providers: [HttpQueryService, ProviderAuthGuard],
})
export class HttpModule {}

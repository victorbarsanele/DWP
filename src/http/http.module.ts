import { Module } from "@nestjs/common";
import { ApplicationModule } from "../application/application.module";
import { HttpQueryService } from "./query.service";
import { WalletController } from "./wallet.controller";

@Module({
  imports: [ApplicationModule],
  controllers: [WalletController],
  providers: [HttpQueryService],
})
export class HttpModule {}

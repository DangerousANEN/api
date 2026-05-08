import { Module } from "@nestjs/common";
import { HudsService } from "./huds.service";
import { HudsController } from "./huds.controller";
import { S3Module } from "../s3/s3.module";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [S3Module, HasuraModule],
  providers: [HudsService, loggerFactory()],
  controllers: [HudsController],
  exports: [HudsService],
})
export class HudsModule {}

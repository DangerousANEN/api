import { Module } from "@nestjs/common";
import { IntrosService } from "./intros.service";
import { IntrosController } from "./intros.controller";
import { S3Module } from "../s3/s3.module";
import { HasuraModule } from "../hasura/hasura.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [S3Module, HasuraModule],
  providers: [IntrosService, loggerFactory()],
  controllers: [IntrosController],
  exports: [IntrosService],
})
export class IntrosModule {}

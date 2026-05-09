import { Module } from "@nestjs/common";
import { HighlightsController } from "./highlights.controller";
import { HighlightsService } from "./highlights.service";
import { HasuraModule } from "../hasura/hasura.module";

@Module({
  imports: [HasuraModule],
  providers: [HighlightsService],
  controllers: [HighlightsController],
  exports: [HighlightsService],
})
export class HighlightsModule {}

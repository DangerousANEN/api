import { Module } from "@nestjs/common";
import { HudStreamController } from "./hud-stream.controller";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  providers: [loggerFactory()],
  controllers: [HudStreamController],
})
export class HudStreamModule {}

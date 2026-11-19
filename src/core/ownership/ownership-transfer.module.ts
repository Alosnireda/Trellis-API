import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  OwnershipTransfer,
  OwnershipTransferAuditEvent,
} from "./entities/ownership-transfer.entity";
import { OwnershipTransferService } from "./ownership-transfer.service";
import { OwnershipTransferController } from "./ownership-transfer.controller";

@Module({
  imports: [TypeOrmModule.forFeature([OwnershipTransfer, OwnershipTransferAuditEvent])],
  controllers: [OwnershipTransferController],
  providers: [OwnershipTransferService],
  exports: [OwnershipTransferService],
})
export class OwnershipTransferModule {}

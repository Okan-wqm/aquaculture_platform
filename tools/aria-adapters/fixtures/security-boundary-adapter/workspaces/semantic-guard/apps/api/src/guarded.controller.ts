import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from './jwt.guard';
// FP-trap (judge-diagnosed class): the guard lives on the CLASS, not the
// method — a scanner that only reads method decorators fires here wrongly.
@UseGuards(JwtAuthGuard)
@Controller('billing')
export class GuardedBillingController {
  @Post()
  create() {
    return 'ok';
  }
}

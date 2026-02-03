import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsUUID,
  IsDateString,
  IsBoolean,
  IsOptional,
  ValidateNested,
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

@InputType()
export class ShiftAssignmentInput {
  @Field()
  @IsDateString()
  date!: string;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  @ValidateIf((o) => !o.isOffDay)
  shiftId?: string; // null for off day

  @Field()
  @IsBoolean()
  isOffDay!: boolean;
}

@InputType()
export class BulkAssignShiftsInput {
  @Field(() => ID)
  @IsUUID()
  weeklyPlanId!: string;

  @Field(() => [ShiftAssignmentInput])
  @IsArray()
  @ArrayMinSize(1, { message: 'En az 1 atama gereklidir' })
  @ArrayMaxSize(100, { message: 'Tek seferde en fazla 100 atama yapilabilir' })
  @ValidateNested({ each: true })
  @Type(() => ShiftAssignmentInput)
  assignments!: ShiftAssignmentInput[];
}

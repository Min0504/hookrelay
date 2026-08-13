import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @Length(2, 100)
  name!: string;

  @IsOptional()
  @IsIn(['FREE', 'PRO'])
  plan?: 'FREE' | 'PRO';
}

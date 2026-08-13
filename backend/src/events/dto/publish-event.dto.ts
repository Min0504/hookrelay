import { IsObject, IsString, Length, Matches } from 'class-validator';
import { EVENT_TYPE_PATTERN } from '../../endpoints/dto/endpoint.dtos';

export class PublishEventDto {
  @IsString()
  @Length(1, 100)
  @Matches(EVENT_TYPE_PATTERN, {
    message: '이벤트 타입은 점 표기 소문자여야 합니다 (예: order.created).',
  })
  type!: string;

  @IsObject({ message: 'payload는 JSON 객체여야 합니다.' })
  payload!: Record<string, unknown>;
}

import { Module } from '@nestjs/common';
import { SecretCipher } from '../common/crypto/secret-cipher';
import { SsrfService } from '../security/ssrf.service';
import { EndpointsController } from './endpoints.controller';
import { EndpointsService } from './endpoints.service';

@Module({
  controllers: [EndpointsController],
  providers: [EndpointsService, SsrfService, SecretCipher],
})
export class EndpointsModule {}

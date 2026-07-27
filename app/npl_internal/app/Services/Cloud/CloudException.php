<?php

declare(strict_types=1);

namespace App\Services\Cloud;

use RuntimeException;
use Throwable;

/**
 * Typed cloud failure. EdgeHost classified errors by substring-matching
 * exception messages ("timed out", "license"), which breaks the moment a
 * driver or locale changes the wording — here the code is carried.
 */
final class CloudException extends RuntimeException
{
    public const UNREACHABLE = 'CLOUD_UNREACHABLE';

    public const UNAUTHORISED = 'LICENSE_INVALID';

    public const RATE_LIMITED = 'CLOUD_RATE_LIMITED';

    public const BAD_RESPONSE = 'CLOUD_BAD_RESPONSE';

    public const SERVER_ERROR = 'CLOUD_SERVER_ERROR';

    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly ?int $status = null,
        ?Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }

    public function isRetryable(): bool
    {
        return in_array($this->errorCode, [self::UNREACHABLE, self::RATE_LIMITED, self::SERVER_ERROR], true);
    }
}

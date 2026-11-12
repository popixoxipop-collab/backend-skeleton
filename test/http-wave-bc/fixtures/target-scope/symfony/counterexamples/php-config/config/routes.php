<?php

use App\Controller\UserController;
use Symfony\Component\Routing\Loader\Configurator\RoutingConfigurator;

return static function (RoutingConfigurator $routes): void {
    $routes->add('php_only', '/php-only')
        ->controller([UserController::class, 'create'])
        ->methods(['GET']);
};

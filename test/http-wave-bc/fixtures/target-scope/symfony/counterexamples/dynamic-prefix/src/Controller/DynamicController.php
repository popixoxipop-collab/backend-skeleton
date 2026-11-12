<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/{tenant}')]
final class DynamicController
{
    #[Route('/users', methods: ['GET'], condition: "request.headers.get('X-Feature') == 'enabled'")]
    public function users(): Response
    {
        return new Response('users');
    }
}

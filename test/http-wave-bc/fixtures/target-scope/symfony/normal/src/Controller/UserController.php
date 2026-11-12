<?php

namespace App\Controller;

use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/api', name: 'api_')]
final class UserController
{
    #[Route('/users/{id}', name: 'user', methods: ['GET'])]
    public function show(string $id): Response
    {
        return new Response($id);
    }

    #[Route('/users', name: 'create', methods: ['POST'])]
    public function create(): Response
    {
        return new Response('created');
    }
}

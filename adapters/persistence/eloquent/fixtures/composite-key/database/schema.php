<?php

use Illuminate\Database\Capsule\Manager as DB;
use Illuminate\Database\Schema\Blueprint;

DB::schema()->create('hero_team_links', function (Blueprint $table) {
    $table->unsignedBigInteger('team_id');
    $table->unsignedBigInteger('hero_id');
    $table->unsignedInteger('joined_year')->nullable();
    $table->primary(['team_id', 'hero_id']);
});

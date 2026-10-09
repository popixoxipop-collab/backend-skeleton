<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class HeroTeamLink extends Model
{
    protected $table = 'hero_team_links';
    protected $primaryKey = 'team_id';
    public $incrementing = false;
}

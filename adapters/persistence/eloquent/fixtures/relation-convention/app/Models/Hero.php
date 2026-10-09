<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Hero extends Model
{
    protected $table = 'heroes';
    protected $primaryKey = 'id';

    public function team()
    {
        return $this->belongsTo(Team::class);
    }
}

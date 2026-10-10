from django.http import JsonResponse


def make_view(name):
    def view(request):
        return JsonResponse({"name": name})

    return view

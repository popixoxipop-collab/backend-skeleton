using UnityEngine;

public class ToggleActor : MonoBehaviour
{
    private void Start()
    {
        gameObject.SetActive(false);
        Destroy(gameObject);
    }
}
